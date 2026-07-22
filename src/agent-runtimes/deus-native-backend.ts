/**
 * `deus-native` AgentRuntime adapter (LIA-401 / B1).
 *
 * Unlike `claude`/`openai`/`llama-cpp` (thin `ContainerRuntime` wrappers that
 * spawn an isolated container and talk over IPC — see `container-backend.ts`),
 * `deus-native` is a standalone `AgentRuntime` implementation: it runs
 * LangChain's `createAgent` IN-PROCESS on the host. This is the first
 * production-registered, host-side, zero-container-sandboxed LLM execution
 * path in this repo — see docs/decisions/deus-v2-langchain-runtime.md for the
 * architectural decision and its threat-model reasoning.
 *
 * Non-goals of this adapter, intentionally deferred to later roadmap items
 * (do not add these here):
 * - Persona context and broader context-registry surfaces such as
 *   `MEMORY_TREE.md` and solution atoms. D4/LIA-418 closes the three accepted
 *   repository instruction-file gaps through lifecycle-events.ts; the
 *   unrelated persona and memory surfaces remain on their existing paths or
 *   deferred roadmap items.
 * - Real backend-scoped session persistence via the LangGraph checkpointer
 *   lands here (B4/LIA-404): the MESSAGE exchange itself genuinely persists
 *   and resumes across turns. Still deferred: session-open repository
 *   instruction content injected via `wrapModelCall`'s `systemMessage`
 *   remains a per-call,
 *   EPHEMERAL override — it is never written into the checkpointed
 *   `messages` state (confirmed: `AgentNode`'s `baseHandler` passes it
 *   directly to the model call and only ever writes the model's OWN response
 *   back into graph state) — so B3's documented once-per-session-lifecycle
 *   injection limitation is NOT fixed by this plan, contrary to an earlier
 *   draft's incorrect claim; re-supplying system context on every resumed
 *   turn (or persisting it into message state some other way) is real,
 *   separate future work, deliberately out of this ticket's scope. Also
 *   still deferred: `startOrResume` real-lookup parity for
 *   `multi-agent/orchestrator.ts`'s one-shot task path (correctly out of
 *   scope — that caller mints a fresh one-shot task per call by design) and
 *   any cleanup/expiry of accumulated checkpoint rows (unbounded growth, a
 *   separate future concern).
 * - Any tool beyond web_search/web_fetch. B7/LIA-407 landed the wrapToolCall
 *   permission-rules engine (permission-rules.ts + middleware-stack.ts's
 *   real permissions layer, profile-selected via
 *   backendConfig.permissionProfile below), but it is an AUTHORIZATION layer
 *   only — SAFE_TOOL_NAMES is unchanged and widening the live tool surface
 *   still requires its own isolation review plus the replay-safety contract
 *   (docs/decisions/deus-v2-replay-safety.md).
 * - Middleware layer SUBSTANCE beyond permissions, memory, and wardens. The
 *   ordered/configurable middleware stack itself landed with B2/LIA-402, B7
 *   made the permissions layer real, D1/LIA-415 made the memory layer real
 *   for CONTROL-GROUP turns (one beforeModel retrieval per turn through the
 *   unchanged scripts/memory_retrieval_hook.py — non-control groups keep
 *   the pass-through observer on group-scoping safety grounds, tracked as
 *   AAG-014), and C1/LIA-409 made the wardens layer real (the unchanged
 *   `scripts/codex_warden_hooks.py` plan-review/code-review/ai-eng/
 *   verification gates now run over the deus-native `wrapToolCall` path).
 *   Telemetry remains the sole explicit observe-only placeholder (-> real
 *   usage accounting).
 * - Replay-safety auditing (B5/LIA-405), token/usage accounting events
 *   (B6/LIA-406).
 * - Nested subagent dispatch (B8/LIA-408) is now real: `runTurn()` builds a
 *   `dispatch_nested_agent` tool (`nested-dispatch-tool.ts`) so the parent
 *   agent can delegate a self-contained, contract-validated subtask to a
 *   one-shot, in-process child `createAgent` with its own independently
 *   selected model. This is NOT `src/multi-agent/orchestrator.ts`'s
 *   container-based `SubagentTask[]` scheduler — that primitive is
 *   unchanged; see docs/decisions/deus-v2-subagent-dispatch.md for how the
 *   two coexist.
 * - Consuming the middleware stack's inspectable `logs` output (added per
 *   ai-eng-warden review). `buildMiddlewareStack(...).logs` is discarded
 *   here (only `middleware` is destructured) -- each layer's log becomes a
 *   real observability/debug sink alongside whichever future item lands
 *   that layer's substance (B7 for permissions, telemetry's own usage-
 *   accounting work for that layer, etc.), not as part of B2 itself.
 */

import crypto from 'crypto';
import os from 'node:os';
import path from 'node:path';

import { createAgent, type AgentMiddleware } from 'langchain';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';

import { FatalError } from '../errors/index.js';
import { logger } from '../logger.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RunContext,
  RunResult,
  RuntimeEventSink,
} from './types.js';
import { defaultSession } from './types.js';
import type { ContainerRuntimeDeps } from './container-backend.js';
import {
  buildSafeTools,
  type ToolBrokerContext,
} from './tool-broker-langchain-adapter.js';
import {
  buildMiddlewareStack,
  resolveMiddlewareStackConfig,
} from './middleware-stack.js';
import type { SessionAlwaysAllowGrants } from './always-allow-grants.js';
import type { PendingPermissionRegistry } from './permission-registry.js';
import {
  buildPromptLifecycleHook,
  loadSessionOpenContext,
  type PromptEventRecord,
} from './lifecycle-events.js';
import { getCheckpointer } from './checkpointer.js';
import { buildContextCompactionMiddleware } from './context-compaction.js';
import { retrieveMemoryContext } from './memory-retrieval.js';
import { createTurnUsageCollector } from './deus-native-usage.js';
import { buildNestedDispatchTool } from './nested-dispatch-tool.js';
import { loadAgentSpecs, type LoadedAgentSpec } from './agent-spec-loader.js';
import { DEUS_NATIVE_TRANSPORT, PROJECT_ROOT } from '../config.js';
import { ClaudeCliSessionPool } from './cli-subprocess/claude-cli-session-pool.js';
import { runParentTurnViaCliSubprocess } from './cli-subprocess/parent-turn-runner.js';
import {
  acquireThreadTurnLease,
  type ThreadTurnLease,
} from './cli-subprocess/process-lifecycle-registry.js';
import {
  buildNativeModelClient,
  parseEffectiveNativeModelConfig,
  resolveEffectiveRoleModel,
} from './model-selection.js';
import {
  loadWardenRoleModels,
  resolveWardenModelAlias,
} from './warden-role-models.js';
import {
  appendDeusNativeTranscriptTurn,
  type TranscriptToolCall,
  type TranscriptUsageEvent,
} from './transcript-store.js';

// capabilities() — each flag has an inline rationale, matching
// llama-cpp-backend.ts's existing comment convention.
const DEUS_NATIVE_CAPABILITIES: RuntimeCapabilities = {
  // Deliberately false: the tool-broker's bash_exec spawns `/bin/bash -lc`
  // with the full inherited environment and no namespace isolation — safe
  // today only because a CONTAINER is the sandbox boundary. deus-native runs
  // in-process on the host with no container between the model and the
  // machine. B7/LIA-407's permission-rules engine now exists, but it is an
  // application-level AUTHORIZATION layer, not a sandbox — wiring shell
  // execution still requires real isolation review plus the replay-safety
  // contract, so this stays false.
  shell: false,
  // Deliberately false: resolveWorkspacePath's `/workspace/*` allowlist was
  // designed and tested as a CONTAINER boundary, not a host boundary — it
  // "protects" the host only by the accident that /workspace/* doesn't exist
  // there. Filesystem tools stay unwired for the same reason as shell above.
  filesystem: false,
  // True: web_search/web_fetch are the only tools wired in B1 (the proven-
  // safe subset A1's spike validated — neither spawns a shell nor touches
  // resolveWorkspacePath), with web_fetch host-allowlisted.
  web: true,
  // False: no image input handling in this PR's runTurn.
  multimodal: false,
  // False: same parity gap as every other backend today.
  handoffs: false,
  // True (B4/LIA-404): runTurn wires the LangGraph SqliteSaver checkpointer
  // (checkpointer.ts) with RuntimeSession.session_id as the thread_id, so a
  // stored session id IS a real, resumable message-thread identifier.
  persistent_sessions: true,
  // False: runTurn returns one buffered result, no incremental deltas.
  tool_streaming: false,
};

/**
 * Production allowlist (LIA-444) of `.claude/agents/*.md` role names that
 * `dispatch_nested_agent` may expose to an end chat user as a delegatable
 * SubAgent role. `loadAgentSpecs()` loads ALL 28+ direct role specs today —
 * including internal pipeline/gate agents (`code-reviewer`, `plan-reviewer`,
 * `ai-eng-warden`, `threat-modeler`, `verification-gate`, etc.) whose prompts
 * assume a diff/plan review context, not arbitrary chat delegation. This
 * allowlist is the ONLY thing that stands between that full internal roster
 * and the chat-visible tool catalog — `loadFilteredAgentSpecs()` below never
 * returns an unfiltered map to any caller. Adding a new chat-dispatchable
 * role is a deliberate edit to this Set, not an automatic consequence of
 * adding a new `.claude/agents/*.md` file.
 */
const PRODUCTION_CHAT_DISPATCHABLE_ROLES: ReadonlySet<string> = new Set([
  'researcher',
]);

/**
 * Loads the production nested-dispatch role catalog, filtered to
 * `PRODUCTION_CHAT_DISPATCHABLE_ROLES`. `loadAgentSpecs()` throws
 * `FatalError` if ANY direct `.claude/agents/*.md` spec is malformed — even
 * one wholly unrelated to chat dispatch (e.g. a typo in an unrelated
 * warden's frontmatter) — so a single bad checked-in file must not crash
 * `DeusNativeRuntime`'s constructor. On failure this logs and falls back to
 * an empty catalog: chat dispatch becomes unavailable (every `agentId` is
 * rejected as unknown) rather than the whole runtime failing to construct.
 */
function loadFilteredAgentSpecs(): ReadonlyMap<string, LoadedAgentSpec> {
  let specs: Map<string, LoadedAgentSpec>;
  try {
    specs = loadAgentSpecs();
  } catch (err) {
    logger.error(
      { err },
      'DeusNativeRuntime: loadAgentSpecs() failed — falling back to an ' +
        'empty nested-dispatch role catalog (chat SubAgent dispatch ' +
        'unavailable until the malformed .claude/agents/*.md spec is fixed)',
    );
    return new Map();
  }
  const filtered = new Map<string, LoadedAgentSpec>();
  for (const name of PRODUCTION_CHAT_DISPATCHABLE_ROLES) {
    const spec = specs.get(name);
    if (spec !== undefined) filtered.set(name, spec);
  }
  return filtered;
}

/** Web-fetch host allowlist. Empty by default: opt-in via env, deny-by-default. */
function resolveAllowedWebFetchHosts(): string[] {
  const raw = process.env.DEUS_NATIVE_WEB_FETCH_ALLOWED_HOSTS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function buildToolBrokerContext(runContext: RunContext): ToolBrokerContext {
  // web_search and web_fetch never touch ctx.containerInput beyond identity
  // fields (confirmed by reading executeBrokerTool's web_search/web_fetch
  // case bodies in container/agent-runner/src/tool-broker.ts) — this context
  // is sufficient for the only two tools buildSafeTools ever returns.
  return {
    cwd: runContext.cwd ?? process.cwd(),
    containerInput: {
      groupFolder: runContext.groupFolder,
      chatJid: runContext.chatJid,
      isControlGroup: runContext.isControlGroup,
    },
  };
}

export class DeusNativeRuntime implements AgentRuntime {
  // LIA-411: loaded ONCE at construction (not per-turn) and stored as an
  // instance field — `.claude/agents/<name>.md` files change rarely
  // (checked-in, not per-request), so re-reading every turn would be pure
  // waste. `runTurn` reads this via `this.wardenRoleModels`, never
  // re-invoking `loadWardenRoleModels` itself.
  private readonly wardenRoleModels: Map<string, string>;

  // LIA-444: loaded ONCE at construction, same rationale as
  // `wardenRoleModels` above — already filtered to
  // `PRODUCTION_CHAT_DISPATCHABLE_ROLES` by `loadFilteredAgentSpecs()`, so
  // this field NEVER holds the raw, unfiltered `loadAgentSpecs()` result.
  private readonly agentSpecs: ReadonlyMap<string, LoadedAgentSpec>;

  constructor(
    private deps: ContainerRuntimeDeps,
    // Interactive-permission follow-up (Amendment 2026-07-21 in
    // docs/decisions/deus-v2-permission-rules.md): the process-wide
    // pending-permission registry, threaded from the composition root via
    // createProductionRuntimeRegistry. Optional — when absent, an 'ask'
    // policy verdict fails closed to deny in the permissions middleware.
    private permissionRegistry?: PendingPermissionRegistry,
    // Session-scoped `allow_always` grants (2026-07-22 Amendment), threaded
    // from the composition root the same way as `permissionRegistry` above.
    // Optional — when absent, `allow_always` behaves identically to
    // `allow_once` (no persistence), preserving pre-amendment behavior.
    private alwaysAllowGrants?: SessionAlwaysAllowGrants,
  ) {
    this.wardenRoleModels = loadWardenRoleModels();
    this.agentSpecs = loadFilteredAgentSpecs();
  }

  name(): 'deus-native' {
    return 'deus-native';
  }

  capabilities(): RuntimeCapabilities {
    return DEUS_NATIVE_CAPABILITIES;
  }

  async startOrResume(_runContext: RunContext): Promise<RuntimeSession> {
    // Mirrors ContainerRuntime.startOrResume's existing stub pattern exactly
    // (container-backend.ts:46-48) — real session lookup happens at the
    // orchestrator layer (db.getSession) before the runtime is invoked, not
    // inside the adapter. Real persistence integration is B4's job
    // (LIA-404); this must not invent a parallel mechanism that would
    // conflict with it.
    return defaultSession('', 'deus-native');
  }

  async runTurn(
    runContext: RunContext,
    sessionRef: RuntimeSession,
    eventSink: RuntimeEventSink,
  ): Promise<RunResult> {
    // LIA-454 EP-002 step 11: only constructed when DEUS_NATIVE_TRANSPORT ===
    // 'cli-subprocess' (default 'raw-http', unchanged behavior). Scoped to
    // this one runTurn() call — shut down in the `finally` below regardless
    // of which return path this turn takes, so no subprocess from this turn
    // ever survives the turn.
    let cliSubprocessPool: ClaudeCliSessionPool | undefined;
    // LIA-459: the raw-HTTP path's own thread-turn lease (the CLI-subprocess
    // path already acquires this same primitive, keyed on the identical
    // `outgoingSessionId` — see below). Released unconditionally in the
    // `finally` regardless of return path, mirroring `cliSubprocessPool`'s
    // own cleanup-regardless-of-outcome pattern immediately below it.
    let rawHttpLease: ThreadTurnLease | null = null;
    try {
      // publicIngress fail-closed guard (added after code-review: a real gap
      // the earlier drafts missed). container-runner.ts's buildContainerArgs
      // refuses to launch a publicIngress (webhook-originated) group on any
      // backend but 'claude', since the reduced-privilege curated-tool
      // profile is enforced only on that path -- "refuse to launch rather
      // than silently downgrade isolation" (its own comment). deus-native
      // never calls buildContainerArgs (it's not a ContainerRuntime wrapper),
      // so without this check a publicIngress group routed to deus-native
      // would run with an UNSCOPED proxy token and the full web_search/
      // web_fetch tool surface instead of the curated webhook profile --
      // the exact silent downgrade that guard exists to prevent. Mirror it
      // here rather than centralizing, matching the per-backend pattern
      // buildContainerArgs itself already uses.
      const group = this.deps.resolveGroup(runContext.groupFolder);
      if (group?.containerConfig?.publicIngress === true) {
        return {
          status: 'error',
          result: null,
          error:
            `publicIngress group "${group.folder}" requires the 'claude' backend ` +
            `(reduced-privilege profile is claude-only); refusing to run on 'deus-native'`,
        };
      }

      // Validate before constructing any provider client or agent.
      const effectiveModels = parseEffectiveNativeModelConfig(
        runContext.backendConfig?.['modelSelection'],
      );

      // B4 (LIA-404): the session_id doubles as the LangGraph checkpointer
      // thread_id, so it's computed FIRST — needed before invoke() runs, not
      // just as the RunResult.sessionRef output after. Same echo-if-present/
      // mint-if-empty logic B3 established (keeps db.setSession's dedup on
      // "same id = touch, don't insert" to one row per real session-open),
      // unchanged, just computed earlier.
      const outgoingSessionId =
        sessionRef.session_id !== ''
          ? sessionRef.session_id
          : crypto.randomUUID();
      const transcriptUsageEvents: TranscriptUsageEvent[] = [];
      const usageEventSink: RuntimeEventSink = async (event) => {
        if (event.type === 'usage') {
          transcriptUsageEvents.push({
            provider: event.provider,
            model: event.model,
            ...(event.inputTokens !== undefined
              ? { inputTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens !== undefined
              ? { outputTokens: event.outputTokens }
              : {}),
            ...(event.totalTokens !== undefined
              ? { totalTokens: event.totalTokens }
              : {}),
          });
        }
        await eventSink(event);
      };

      // B8 (LIA-408)/LIA-454 EP-002 step 11: hoisted above the transport
      // branch below (both need it) — construction has no side effects, so
      // moving it earlier changes nothing observable for the raw-HTTP path.
      const usageCollector = createTurnUsageCollector({
        sessionId: outgoingSessionId,
        eventSink: usageEventSink,
      });
      // D5 (LIA-419)/LIA-454 EP-002 step 11: hoisted for the same reason —
      // a fresh random UUID's value is unaffected by when it's generated.
      const currentTurnMessageId = crypto.randomUUID();

      // LIA-454 EP-002 step 11: shared post-processing (tool-call
      // extraction/events, usage recording, output/completion events,
      // RunResult construction, transcript append) for EITHER transport —
      // not duplicated per branch. `startedAt` stays branch-local (real
      // wall-clock timing, unlike the ID above) rather than hoisted.
      const finalizeSuccessfulTurn = async (params: {
        messages: BaseMessage[];
        text: string;
        assistantMessageId: unknown;
        primaryModel: string;
        primaryProvider: 'anthropic';
        startedAt: Date;
      }): Promise<RunResult> => {
        const {
          messages,
          text,
          assistantMessageId,
          primaryModel,
          primaryProvider,
          startedAt,
        } = params;
        const transcriptToolCalls: TranscriptToolCall[] = [];
        for (const message of messages) {
          const m = message as {
            tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
          };
          if (Array.isArray(m.tool_calls)) {
            for (const call of m.tool_calls) {
              if (!call.name) continue;
              const transcriptInput =
                call.args !== null &&
                typeof call.args === 'object' &&
                !Array.isArray(call.args)
                  ? (call.args as Record<string, unknown>)
                  : {};
              transcriptToolCalls.push({
                ...(call.id !== undefined ? { id: call.id } : {}),
                name: call.name,
                input: transcriptInput,
              });
              await eventSink({
                type: 'tool_call',
                name: call.name,
                arguments: (call.args as Record<string, unknown>) ?? {},
              });
            }
          }
        }

        await usageCollector.record(messages, {
          provider: primaryProvider,
          model: primaryModel,
        });
        const turnUsage = usageCollector.aggregate();

        const completedAt = new Date();
        await eventSink({ type: 'output_text', text });
        await eventSink({ type: 'turn_complete' });

        const runResult: RunResult = {
          status: 'success',
          result: text,
          sessionRef: { backend: 'deus-native', session_id: outgoingSessionId },
          ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
        };
        try {
          await appendDeusNativeTranscriptTurn({
            sessionId: outgoingSessionId,
            groupFolder: runContext.groupFolder,
            ...(runContext.cwd !== undefined ? { cwd: runContext.cwd } : {}),
            prompt: runContext.prompt,
            assistantText: text,
            userMessageId: currentTurnMessageId,
            ...(typeof assistantMessageId === 'string'
              ? { assistantMessageId }
              : {}),
            primaryModel,
            toolCalls: transcriptToolCalls,
            usageEvents: transcriptUsageEvents,
            startedAt,
            completedAt,
          });
        } catch (error) {
          console.warn(
            `deus-native transcript append unexpectedly rejected for session ${outgoingSessionId}`,
            error,
          );
        }
        return runResult;
      };

      if (DEUS_NATIVE_TRANSPORT === 'cli-subprocess') {
        // LIA-454 EP-002 step 11: the parent loop itself now routes through
        // the CLI-subprocess transport too (previously only nested-dispatch
        // children did, PR #47) — this flag now selects the COMPLETE
        // parent-and-nested CLI strategy, not a mix of raw-HTTP parent +
        // CLI-subprocess children (that combination is no longer
        // selectable; see config.ts's updated comment). None of the
        // raw-HTTP machinery below (buildNativeModelClient, the raw
        // middleware stack, buildSafeTools/dispatchTool/tools, createAgent/
        // agent.invoke) is constructed on this branch.
        //
        // Scope carve-out (EP-002's Goal section, plan-review round 1/2):
        // fixes the severe zero-history bug in step 10's
        // parent-turn-runner.ts (prior checkpoint messages were read but
        // never sent to the CLI). Context-compaction (LIA-457) and
        // control-group memory-recall (LIA-458) are now integrated (below).
        // Nested-dispatch child usage from inside parent-turn-mcp-server.ts's
        // own subprocess is not yet folded into RunResult.usage (LIA-460) —
        // a real, named, documented gap, not silently dropped. The raw-HTTP
        // path's own thread-turn lease is also deliberately NOT added here
        // (LIA-459) — see EP-002's "Chosen approach" section for why.
        const rawPermissionProfile =
          runContext.backendConfig?.['permissionProfile'];
        if (
          rawPermissionProfile !== undefined &&
          typeof rawPermissionProfile !== 'string'
        ) {
          throw new Error(
            `deus-native: backendConfig.permissionProfile must be a string ` +
              `profile name, got ${typeof rawPermissionProfile}`,
          );
        }
        const wardenCwd = path.resolve(
          runContext.worktreePath ?? runContext.cwd ?? process.cwd(),
        );
        const toolCtx = buildToolBrokerContext(runContext);

        cliSubprocessPool = new ClaudeCliSessionPool({
          // Mirrors the nested-dispatch site's own established convention
          // (below, in the now-superseded raw-HTTP-only wiring) — a small
          // in-process bound; the step-9 cross-process slot registry is the
          // authoritative production-wide cap, this is defense in depth.
          maxProcesses: 3,
          idleTimeoutMs: 120_000,
          terminationGraceMs: 3_000,
          onEvent: () => {},
        });
        const mcpServerScriptPath = path.join(
          PROJECT_ROOT,
          'src/agent-runtimes/cli-subprocess/parent-turn-mcp-server.ts',
        );
        const mcpServerName = 'deus_lia454_parent';
        const startedAt = new Date();

        // LIA-458: same personal-vault isolation gate as the raw-HTTP
        // branch's own memoryRequest construction below —
        // memory_retrieval_hook.py reads the user's PERSONAL vault and is
        // not group-scoped, so it must never even be attempted for a
        // non-control-group turn. Eager (not lazy like the raw-HTTP path's
        // beforeModel hook) — confirmed cosmetic, not a new latency class:
        // the raw-HTTP path's own hook already fires unconditionally and
        // synchronously on every control-group turn's only model call.
        const recalledMemoryContext = runContext.isControlGroup
          ? await retrieveMemoryContext({
              prompt: runContext.prompt,
              sessionId: outgoingSessionId,
            })
          : undefined;

        const outcome = await runParentTurnViaCliSubprocess(
          {
            threadId: outgoingSessionId,
            prompt: runContext.prompt,
            currentTurnMessageId,
            model: effectiveModels.main.model,
            ...(runContext.isControlGroup ? { recalledMemoryContext } : {}),
            mcpServerContext: {
              permissionProfile: rawPermissionProfile,
              wardenCwd,
              workspaceRoot: wardenCwd,
              safeToolCwd: toolCtx.cwd,
              allowedWebFetchHosts: resolveAllowedWebFetchHosts(),
              parentSessionId: outgoingSessionId,
              effectiveModels,
              agentCatalogIds: Array.from(this.agentSpecs.keys()),
            },
          },
          {
            pool: cliSubprocessPool,
            mcpServerScriptPath,
            mcpServerName,
            repoRoot: PROJECT_ROOT,
            scratchDirFor: (conversationId) =>
              path.join(
                os.tmpdir(),
                'deus-lia454-parent-turn',
                outgoingSessionId,
                conversationId,
              ),
            saver: getCheckpointer(),
            loadSessionOpenText: async () =>
              (await loadSessionOpenContext(runContext, group)).systemMessage,
          },
        );

        if (outcome.status === 'error') {
          return { status: 'error', result: null, error: outcome.error };
        }

        // LIA-460: fold any nested-dispatch child usage into the SAME
        // collector the parent's own messages feed below, BEFORE
        // finalizeSuccessfulTurn reads usageCollector.aggregate() — so
        // RunResult.usage reflects parent-plus-every-child total, matching
        // the raw-HTTP path's own onUsage-callback behavior.
        for (const entry of outcome.nestedUsageEvents) {
          await usageCollector.recordRaw(entry, {
            provider: entry.provider,
            model: entry.model,
          });
        }

        return await finalizeSuccessfulTurn({
          messages: outcome.newMessages,
          text: outcome.finalAssistantText,
          assistantMessageId: outcome.finalAssistantMessageId,
          primaryModel:
            outcome.model !== '' ? outcome.model : effectiveModels.main.model,
          primaryProvider: outcome.provider,
          startedAt,
        });
      }

      // LIA-459: acquire the SAME cross-process thread-turn lease the
      // CLI-subprocess path already uses (process-lifecycle-registry.ts),
      // keyed on the identical `outgoingSessionId` — this closes both the
      // raw/raw race AND the mixed raw/CLI race EP-002 already documented as
      // a deferred gap, since both transports now key the identical lease
      // namespace. No `leaseOptions` override — the real defaults (real
      // STORE_DIR, the lease's own bounded internal retry) are what make
      // this share that namespace. Acquired BEFORE the checkpoint read
      // below, matching the CLI path's own acquire-before-read ordering.
      // On contention, fail this turn immediately — mirrors the CLI path's
      // own established behavior (parent-turn-runner.ts); verified no
      // runTurn() caller retries on status:'error', so no caller needs new
      // handling for this error shape.
      rawHttpLease = await acquireThreadTurnLease(outgoingSessionId);
      if (rawHttpLease === null) {
        return {
          status: 'error',
          result: null,
          error: `deus-native: could not acquire the thread-turn lease for "${outgoingSessionId}" — another turn is already in flight for this thread`,
        };
      }

      // B4 (LIA-404): read the real checkpoint state ONCE to derive the
      // injection-gating signal. This happens before invoke()'s own internal
      // getTuple() in the same process — both read the identical "before this
      // turn" state.
      const priorTuple = await getCheckpointer().getTuple({
        configurable: { thread_id: outgoingSessionId },
      });
      // isNewSession = "does a REAL checkpoint exist for this thread_id" —
      // deliberately NOT B3's `sessionRef.session_id === ''` string check.
      // B3-era production rows carry non-empty, UUID-shaped session_ids that
      // were NEVER real checkpointer threads (B3's own marker was explicitly
      // "not a real resumable checkpoint ID"); under the old string signal,
      // the first post-B4 turn for such a row would misclassify as "resumed",
      // skip session-open repository-context injection, AND hand the
      // checkpointer a
      // thread_id it has never seen — a fresh, memoryless context with no
      // group rules either. Under this checkpoint-existence signal the same
      // pre-existing id is still echoed back (preserving the DB row's
      // identity) AND correctly triggers re-injection, because from the
      // checkpointer's perspective it truthfully IS a new session. This one
      // signal is the entire upgrade-path fix — no migration, no backfill.
      const isNewSession = priorTuple === undefined;

      // Session-open injection fires only on a genuinely NEW session (once
      // per open lifecycle — a resumed turn never even calls
      // loadSessionOpenContext) AND only when session-open content actually
      // exists (systemMessage stays undefined otherwise). Awaited because
      // D2's vault aggregate has an async recent-sessions provider; D4's
      // registry is composed after it synchronously. The await occurs ONLY
      // on this new-session branch, bounded by the vault pipeline's 5s
      // subprocess timeout, and never blocks the process-wide event loop.
      // The returned SessionOpenRecord is an inspectable log consumed by
      // tests, matching B2's own discarded-logs precedent here.
      const sessionOpenMessage = isNewSession
        ? (await loadSessionOpenContext(runContext, group)).systemMessage
        : undefined;

      const model = buildNativeModelClient(runContext, effectiveModels.main);
      // D5 (LIA-419): the checkpoint-aware compaction middleware uses this
      // same proxy-routed model for its occasional continuity-summary call.
      // It is composed OUTSIDE and before B2's canonical policy stack below:
      // compaction must replace old checkpointed history before memory's
      // beforeModel hook appends turn-specific recalled context. One-shot
      // nested agents deliberately do not receive it — they have no
      // checkpointer or cross-turn history to compact.
      const contextCompaction = buildContextCompactionMiddleware(model);
      const toolCtx = buildToolBrokerContext(runContext);

      // B2 (LIA-402): ordered, per-layer-toggleable middleware stack —
      // permissions -> wardens -> memory -> telemetry (index 0 outermost).
      // B7 (LIA-407): the permissions layer is REAL — a declarative
      // first-match-wins rule engine (permission-rules.ts) selected by the
      // named profile below. D1 (LIA-415): the memory layer is REAL for
      // control-group turns (see memoryRequest below). C1 (LIA-409): the
      // wardens layer is REAL — it invokes the unchanged
      // `scripts/codex_warden_hooks.py` gate runners over the `wardenCwd`
      // resolved below. Telemetry remains the sole observe-only placeholder
      // (see middleware-stack.ts for its caveat).
      //
      // Profile selection: runContext.backendConfig.permissionProfile.
      // Omitted => 'default' (allow-all — today's behavior, unchanged);
      // 'read-only' => the fail-closed read-only preset. Any other value
      // (unknown name, non-string) THROWS here — before createAgent — and
      // surfaces as this turn's normal status:'error' RunResult rather than
      // silently weakening the requested restriction.
      //
      // B8 (LIA-408): resolved ONCE here (not re-derived further down)
      // because both the parent's own middleware stack AND every
      // nested-dispatch child's fresh middleware stack (rebuilt per-dispatch
      // by buildNestedDispatchTool's `buildChildMiddleware`) select the SAME
      // named profile — a child never runs under a looser policy than its
      // parent. C1 (LIA-409): `wardenCwd` below is resolved once for the
      // same reason and threaded into both call sites — a nested-dispatch
      // child's wardens gate must resolve the same worktree/repo-root as
      // the parent's, never silently default to `process.cwd()`.
      const rawPermissionProfile =
        runContext.backendConfig?.['permissionProfile'];
      if (
        rawPermissionProfile !== undefined &&
        typeof rawPermissionProfile !== 'string'
      ) {
        throw new Error(
          `deus-native: backendConfig.permissionProfile must be a string ` +
            `profile name, got ${typeof rawPermissionProfile}`,
        );
      }
      // Warden event cwd: `worktreePath` wins because autonomous pipeline
      // runs already identify their checked-out worktree explicitly; `cwd`
      // is the normal group/project fallback; `process.cwd()` preserves the
      // existing `buildToolBrokerContext` fallback when neither optional
      // field is present. Always made absolute so the serialized PreToolUse
      // event's `cwd` and the resolved warden repo root are unambiguous
      // regardless of what relative path a caller supplied.
      const wardenCwd = path.resolve(
        runContext.worktreePath ?? runContext.cwd ?? process.cwd(),
      );
      const { middleware } = buildMiddlewareStack(
        resolveMiddlewareStackConfig(),
        {
          permissionProfile: rawPermissionProfile,
          wardenCwd,
          // LIA-410: explicit workspace root for the wardens gate runner,
          // sourced identically to `wardenCwd` above (same already-resolved
          // value — no separate recomputation) — see
          // `BuildMiddlewareStackDeps.workspaceRoot` in middleware-stack.ts.
          workspaceRoot: wardenCwd,
          // D1 (LIA-415): the memory layer's retrieval input — the submitted
          // prompt plus the backend-scoped session id (computed above; it
          // drives the hook's session-concept expansion and injection
          // dedup). CONTROL-GROUP TURNS ONLY: memory_retrieval_hook.py reads
          // the user's PERSONAL vault and is not group-scoped, so supplying
          // it for arbitrary groups would leak personal context across
          // unrelated conversations — exactly the deferral reason the old
          // placeholder documented. Non-control groups keep the layer as a
          // pass-through observer (parity gap tracked as AAG-014 in
          // docs/agent-agnostic-debt.md).
          ...(runContext.isControlGroup
            ? {
                memoryRequest: {
                  prompt: runContext.prompt,
                  sessionId: outgoingSessionId,
                },
              }
            : {}),
          // Interactive 'ask' channel (Amendment 2026-07-21): only when the
          // composition root wired a registry. `usageEventSink` is reused
          // as-is — it is already a transparent passthrough for every
          // non-'usage' event, so `permission_request` flows straight to the
          // caller's eventSink (and the activity broadcaster around it).
          // RAW-HTTP BRANCH ONLY: nested-dispatch children
          // (`buildChildMiddleware` below) deliberately do NOT receive this —
          // no event-forwarding route back to the caller exists for children,
          // so their 'ask' fails closed to deny (plan Non-goals). The
          // cli-subprocess transport's MCP gate seam likewise has no
          // live-prompt path (fail-closed there too).
          ...(this.permissionRegistry !== undefined
            ? {
                permissionInteractive: {
                  registry: this.permissionRegistry,
                  eventSink: usageEventSink,
                  sessionId: outgoingSessionId,
                  alwaysAllowGrants: this.alwaysAllowGrants,
                },
              }
            : {}),
        },
      );

      // B8 (LIA-408): turn-scoped usage collector, shared by the parent's own
      // per-AIMessage usage recording below AND every nested-dispatch
      // child's `onUsage` callback — one code path builds every 'usage'
      // event and the combined RunResult.usage aggregate, whether the
      // AIMessage came from the parent or from a dispatched child. Hoisted
      // above the transport branch (LIA-454 EP-002 step 11) — see its
      // declaration earlier in this method.

      // B8 (LIA-408): the parent-facing dispatch_nested_agent tool. Every
      // factory below runs AGAIN, fresh, on each individual dispatch (never
      // once here) — resolveModel constructs an independently selected
      // client per dispatch's requested model id (AC4); buildChildTools/
      // buildChildMiddleware build fresh tool/middleware instances per
      // dispatch, so no child ever shares the parent's (or a sibling
      // child's) object by reference, and the child list is a strict subset
      // of the parent's (the child never receives this dispatch tool
      // itself, so recursive nesting is not introduced by this factory
      // alone). onUsage folds every child AIMessage into the SAME
      // usageCollector the parent uses below, using the parent's
      // outgoingSessionId and the child's own resolved model id.
      // LIA-454 EP-002 step 11: the CLI-subprocess-backed nested-dispatch
      // wiring that used to live here (PR #47's walking skeleton) is GONE
      // from this branch — `DEUS_NATIVE_TRANSPORT === 'cli-subprocess'` now
      // returns early via the branch earlier in this method, so this code
      // (reached only when the flag is NOT 'cli-subprocess') never needs a
      // CLI-subprocess dispatcher; `createDispatcher` is simply omitted
      // below, defaulting to the in-process LangChain dispatcher —
      // unchanged from the flag's original 'raw-http' behavior.

      const dispatchTool = buildNestedDispatchTool(
        {
          // LIA-429 closed part of the KNOWN GAP originally noted here: the
          // raw `modelId` string the parent's tool-call arguments supply is
          // now discarded by `resolveEffectiveModelId` below (never reaches
          // `resolveModel`/the credential proxy), and the value that DOES
          // reach it is re-validated against `NATIVE_PROVIDER_REGISTRY`'s
          // allowlist by `buildNativeModelClient` — so there is a real
          // server-side allowlist now, not none.
          //
          // KNOWN GAP still open (ai-eng-warden review; tracked in
          // docs/decisions/deus-v2-subagent-dispatch.md's Risks section, NOT
          // fixed by this ticket): there is still no per-turn dispatch
          // budget — a compromised or misdirected parent can still select
          // the most expensive ALLOWED model tier on an unbounded number of
          // dispatches within one turn. A per-turn dispatch cap is real
          // future work, not silently deferred.
          resolveModel: (modelId) =>
            buildNativeModelClient(runContext, {
              provider: 'anthropic',
              model: modelId,
            }),
          buildChildTools: () =>
            buildSafeTools(toolCtx, resolveAllowedWebFetchHosts()),
          // C1 (LIA-409): thread the SAME resolved `wardenCwd` into every
          // nested-dispatch child's fresh middleware stack — a child's wardens
          // layer must resolve the same worktree/repo-root as the parent's,
          // never silently fall back to `process.cwd()` (this factory runs
          // inside the same process, so an unset wardenCwd wouldn't throw or
          // even look wrong in isolation — it would just gate the wrong
          // worktree).
          buildChildMiddleware: () =>
            buildMiddlewareStack(resolveMiddlewareStackConfig(), {
              permissionProfile: rawPermissionProfile,
              wardenCwd,
              // LIA-410: same explicit workspace root as the parent's own
              // middleware stack above — a nested-dispatch child's wardens
              // gate must resolve the same bucket as the parent's.
              workspaceRoot: wardenCwd,
            }).middleware,
          parentSessionId: outgoingSessionId,
          provider: 'anthropic',
          onUsage: async (observation) => {
            await usageCollector.record([observation.message], {
              provider: 'anthropic',
              model: observation.model,
            });
          },
        },
        {
          modelPolicy: {
            // LIA-411: explicit user role config (`effectiveModels.roles`,
            // set via `deus chat model set --role`) always wins first — it
            // is checked BEFORE the checked-in frontmatter tier, matching
            // `resolveEffectiveRoleModel`'s own exact-role-first precedence.
            // Only when the user has NOT configured this exact role is the
            // dispatched agent's `.claude/agents/<name>.md` `model:`
            // frontmatter (loaded once at construction, see
            // `this.wardenRoleModels` above) consulted; a miss there (no
            // frontmatter entry, or an alias `resolveWardenModelAlias` can't
            // map) falls through to the same configured main/default the
            // pre-LIA-411 behavior used. Never throws.
            resolveEffectiveModelId: (agentId, _requestedModelId) => {
              if (Object.hasOwn(effectiveModels.roles ?? {}, agentId)) {
                return resolveEffectiveRoleModel(effectiveModels, agentId)
                  .model;
              }
              const wardenModel = this.wardenRoleModels.get(agentId);
              const resolved =
                wardenModel !== undefined
                  ? resolveWardenModelAlias(wardenModel)
                  : undefined;
              return (
                resolved ??
                resolveEffectiveRoleModel(effectiveModels, agentId).model
              );
            },
          },
          // LIA-444: the production, chat-reachable dispatch catalog — see
          // `PRODUCTION_CHAT_DISPATCHABLE_ROLES`/`loadFilteredAgentSpecs()`
          // above. Already allowlist-filtered; `buildNestedDispatchTool`
          // exposes every key it's given, so this is the ONLY thing gating
          // which roles a chat user can dispatch.
          agentSpecs: this.agentSpecs,
          // createDispatcher omitted: this branch only runs when
          // DEUS_NATIVE_TRANSPORT is NOT 'cli-subprocess' (see LIA-454
          // EP-002 step 11's branch earlier in this method), so it always
          // uses the default in-process LangChain dispatcher.
        },
      );

      const tools = [
        ...(await buildSafeTools(toolCtx, resolveAllowedWebFetchHosts())),
        dispatchTool,
      ];

      // B3 (LIA-403): the prompt-lifecycle hook is a SEPARATE, small
      // middleware APPENDED after B2's stack — never prepended or inserted,
      // so B2's own already-locked canonical order is untouched (LangChain
      // composes every middleware's beforeModel/wrapModelCall hooks
      // regardless of position). promptEvents is the inspectable per-prompt
      // log, discarded here like B2's own logs.
      const promptEvents: PromptEventRecord[] = [];
      const promptLifecycle = buildPromptLifecycleHook(
        sessionOpenMessage,
        promptEvents,
      );
      // Explicit AgentMiddleware[] annotation: the mixed array literal
      // otherwise infers a shape that misses createAgent's overloads.
      const allMiddleware: AgentMiddleware[] = [
        contextCompaction,
        ...middleware,
        promptLifecycle,
      ];

      const agent = createAgent({
        model,
        tools,
        middleware: allMiddleware,
        // B4 (LIA-404): real conversation continuity — LangGraph loads the
        // prior checkpoint for thread_id and appends this turn's input via
        // the messages channel's own reducer.
        checkpointer: getCheckpointer(),
      });

      // Non-goal (see module doc comment): the prompt sent to createAgent is
      // the bare runContext.prompt — session-open repository context reaches
      // the model via the prompt-lifecycle middleware's wrapModelCall
      // systemMessage injection, never by changing what invoke() receives.
      // D5 (LIA-419): a stable ID marks the beginning of THIS turn in the
      // returned checkpoint state. Message-count slicing is invalid once
      // compaction can replace a large prefix with one summary and make the
      // final state shorter than it was before this turn.
      // (currentTurnMessageId is now hoisted above the transport branch —
      // LIA-454 EP-002 step 11 — see its declaration earlier in this method.)
      const startedAt = new Date();
      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage({
              id: currentTurnMessageId,
              content: runContext.prompt,
            }),
          ],
        },
        { configurable: { thread_id: outgoingSessionId } },
      );

      // result.messages is typed as the broad BaseMessage[] union (matches
      // A1's spike's own printTranscriptMessage pattern) -- only the AIMessage
      // subtype carries tool_calls/content in the shape used below, and
      // narrowing via `instanceof AIMessage` would require importing that
      // class just to satisfy the type checker for two optional-field reads.
      // These casts read tool_calls/content defensively (both accessed via
      // `?.`/Array.isArray, never assumed present) rather than assert a
      // stronger runtime guarantee than the union actually provides.
      //
      // B4/D5: invoke() returns the FULL final checkpoint state, which may now
      // be either longer (ordinary resume) or shorter (compacted resume) than
      // the pre-turn state. Locate the stable current-input ID rather than
      // assuming a preserved prefix length, then scope tool/usage/output work
      // to this turn exactly.
      const allResultMessages = result.messages ?? [];
      const currentTurnStart = allResultMessages.findIndex(
        (message) => message.id === currentTurnMessageId,
      );
      if (currentTurnStart < 0) {
        throw new FatalError(
          'deus-native: current turn input was missing from final agent state',
        );
      }
      const messages = allResultMessages.slice(currentTurnStart);

      const last = messages[messages.length - 1] as
        { content?: unknown } | undefined;
      const text =
        typeof last?.content === 'string'
          ? last.content
          : last?.content !== undefined
            ? JSON.stringify(last.content)
            : '';
      const assistantMessageId = (
        messages[messages.length - 1] as { id?: unknown } | undefined
      )?.id;

      // B6 (LIA-406) + B8 (LIA-408): any nested-dispatch child's usage was
      // already folded into the SAME usageCollector by the dispatch tool's
      // `onUsage` callback during `agent.invoke()` above, so
      // `finalizeSuccessfulTurn`'s own `usageCollector.record(messages, ...)`
      // call below sees the combined parent-plus-every-child total.
      // Hardcoded 'anthropic' because buildProxyRoutedChatAnthropic is the
      // only model-construction path today (single-provider). If a second
      // provider path is added, this must become a function of which client
      // was actually built.
      return await finalizeSuccessfulTurn({
        messages,
        text,
        assistantMessageId,
        primaryModel: effectiveModels.main.model,
        primaryProvider: effectiveModels.main.provider,
        startedAt,
      });
    } catch (err) {
      // Never throw out of runTurn — matches ContainerRuntime.runTurn's
      // never-throw contract (network failure, proxy auth failure, or any
      // other thrown exception surfaces as a status: 'error' result).
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        result: null,
        error: message,
      };
    } finally {
      // LIA-454 EP-002 step 11: no CLI-subprocess process from this turn
      // survives the turn, on any return path (success or error above).
      await cliSubprocessPool?.shutdownAll();
      // LIA-459: no raw-HTTP thread-turn lease from this turn survives the
      // turn either, on any return path — same "regardless of outcome"
      // pattern as the CLI-subprocess pool cleanup immediately above.
      rawHttpLease?.release();
    }
  }

  async close(_sessionRef: RuntimeSession): Promise<void> {
    // Stateless per-turn ChatAnthropic client — no persistent connection or
    // process to release at this stage of the roadmap. Session cleanup
    // handled by host via db.clearSession() (mirrors ContainerRuntime.close's
    // own comment).
  }
}

export function createDeusNativeRuntime(
  deps: ContainerRuntimeDeps,
  permissionRegistry?: PendingPermissionRegistry,
  alwaysAllowGrants?: SessionAlwaysAllowGrants,
): DeusNativeRuntime {
  return new DeusNativeRuntime(deps, permissionRegistry, alwaysAllowGrants);
}
