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
 * - Loading CLAUDE.md/AGENTS.md/AI_AGENT_GUIDELINES.md/persona context into
 *   the prompt (B2 middleware stack or B3 lifecycle events — whichever ends
 *   up owning it). `runTurn` sends the bare `runContext.prompt`, nothing else.
 * - Real session persistence / checkpointer-to-sessions-table integration
 *   (B4/LIA-404). `startOrResume` mirrors ContainerRuntime's own stub.
 * - The wrapToolCall permission-rules engine and any tool beyond
 *   web_search/web_fetch (B7/LIA-407).
 * - Middleware ordering/toggles (B2/LIA-402), lifecycle hook points
 *   (B3/LIA-403), replay-safety auditing (B5/LIA-405), token/usage accounting
 *   events (B6/LIA-406), nested subagent dispatch (B8/LIA-408).
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent } from 'langchain';
import Anthropic from '@anthropic-ai/sdk';

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
import { PROXY_BIND_HOST } from '../container-runtime.js';
import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { detectAuthMode } from '../credential-proxy.js';
import { getOrCreateGroupToken } from '../group-tokens.js';

// capabilities() — each flag has an inline rationale, matching
// llama-cpp-backend.ts's existing comment convention.
const DEUS_NATIVE_CAPABILITIES: RuntimeCapabilities = {
  // Deliberately false: the tool-broker's bash_exec spawns `/bin/bash -lc`
  // with the full inherited environment and no namespace isolation — safe
  // today only because a CONTAINER is the sandbox boundary. deus-native runs
  // in-process on the host with no container between the model and the
  // machine, so shell execution is not wired until a permission-rules engine
  // (B7/LIA-407, wrapToolCall) or equivalent stopgap exists.
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
  // False: B4 (LIA-404) hasn't landed real checkpointer-to-sessions-table
  // integration yet, so a stored session id must not be assumed replayable.
  persistent_sessions: false,
  // False: runTurn returns one buffered result, no incremental deltas.
  tool_streaming: false,
};

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

/**
 * Builds a ChatAnthropic client routed through the live credential proxy at
 * PROXY_BIND_HOST:CREDENTIAL_PROXY_PORT — NOT a hardcoded 127.0.0.1 (bare-
 * metal Linux binds the proxy to the docker0 bridge, not loopback; see
 * docs/decisions/deus-v2-langchain-runtime.md). Branches on detectAuthMode()
 * to build either an API-key-mode or OAuth-mode client via a `createClient`
 * override — same escape-hatch shape as A4's spike
 * (buildProxyRoutedChatAnthropic in
 * scripts/spikes/lia397_credential_proxy_billing_spike.ts), but branching on
 * the REAL auth mode rather than hardcoding OAuth like that spike does. This
 * is architecturally distinct from A4's spike: that spike deliberately used
 * an isolated, throwaway proxy child; deus-native hits the real production
 * daemon at its real bind address with a real per-group token.
 */
function buildProxyRoutedChatAnthropic(runContext: RunContext): ChatAnthropic {
  const baseURL = `http://${PROXY_BIND_HOST}:${CREDENTIAL_PROXY_PORT}`;
  const proxyToken = getOrCreateGroupToken(runContext.groupFolder);
  const authMode = detectAuthMode();

  return new ChatAnthropic({
    // Fixed at the top model tier for this milestone (ai-eng-warden review:
    // runContext.effort, ContainerRuntime's per-turn tier signal, is not yet
    // honored here). Deliberately deferred, not an oversight -- effort-aware
    // model selection is a real enhancement but not one of B1's stated ACs,
    // and every deus-native turn is already gated behind explicit
    // DEUS_AGENT_BACKEND=deus-native opt-in, not default traffic.
    model: 'claude-opus-4-8',
    createClient: (options) =>
      authMode === 'oauth'
        ? new Anthropic({
            baseURL: options.baseURL ?? baseURL,
            authToken: 'placeholder',
            apiKey: null,
            // Plain `authToken` never populates the SDK's own OAuth credential
            // state, so it never auto-appends this beta header — add it
            // explicitly, or the upstream OAuth-authenticated request can be
            // rejected (matches A4's own header-injection reasoning).
            defaultHeaders: {
              'anthropic-beta': 'oauth-2025-04-20',
              'x-deus-proxy-token': proxyToken,
            },
          })
        : new Anthropic({
            baseURL: options.baseURL ?? baseURL,
            apiKey: 'placeholder',
            defaultHeaders: {
              'x-deus-proxy-token': proxyToken,
            },
          }),
  });
}

export class DeusNativeRuntime implements AgentRuntime {
  constructor(private deps: ContainerRuntimeDeps) {}

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
    _sessionRef: RuntimeSession,
    eventSink: RuntimeEventSink,
  ): Promise<RunResult> {
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

      const model = buildProxyRoutedChatAnthropic(runContext);
      const toolCtx = buildToolBrokerContext(runContext);
      const tools = await buildSafeTools(
        toolCtx,
        resolveAllowedWebFetchHosts(),
      );

      const agent = createAgent({ model, tools });

      // Non-goal (see module doc comment): the prompt sent to createAgent is
      // the bare runContext.prompt — no CLAUDE.md/AGENTS.md/persona context.
      const result = await agent.invoke({
        messages: [{ role: 'user', content: runContext.prompt }],
      });

      // result.messages is typed as the broad BaseMessage[] union (matches
      // A1's spike's own printTranscriptMessage pattern) -- only the AIMessage
      // subtype carries tool_calls/content in the shape used below, and
      // narrowing via `instanceof AIMessage` would require importing that
      // class just to satisfy the type checker for two optional-field reads.
      // These casts read tool_calls/content defensively (both accessed via
      // `?.`/Array.isArray, never assumed present) rather than assert a
      // stronger runtime guarantee than the union actually provides.
      const messages = result.messages ?? [];
      for (const message of messages) {
        const m = message as {
          tool_calls?: Array<{ name?: string; args?: unknown }>;
        };
        if (Array.isArray(m.tool_calls)) {
          for (const call of m.tool_calls) {
            if (!call.name) continue;
            await eventSink({
              type: 'tool_call',
              name: call.name,
              arguments: (call.args as Record<string, unknown>) ?? {},
            });
          }
        }
      }

      const last = messages[messages.length - 1] as
        { content?: unknown } | undefined;
      const text =
        typeof last?.content === 'string'
          ? last.content
          : last?.content !== undefined
            ? JSON.stringify(last.content)
            : '';

      await eventSink({ type: 'output_text', text });
      await eventSink({ type: 'turn_complete' });

      return {
        status: 'success',
        result: text,
      };
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
): DeusNativeRuntime {
  return new DeusNativeRuntime(deps);
}
