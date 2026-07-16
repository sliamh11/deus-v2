/**
 * Runtime lifecycle events for the `deus-native` runtime (LIA-403 / B3).
 *
 * Parallel in spirit to `middleware-stack.ts` (B2) but scoped to
 * `runTurn`-level LIFECYCLE (session-open / per-prompt / turn-complete), not
 * tool/model-call middleware substance. Two concerns live here:
 *
 * 1. **Session-open context loading** (`loadSessionOpenContext`): composes
 *    D2 vault context (LIA-416 — control group only, via
 *    `vault-context.ts`'s `loadVaultContext` facade) with D4's host context
 *    registry (LIA-418), which reads the applicable `AGENTS.md`, `CLAUDE.md`,
 *    and `AI_AGENT_GUIDELINES.md` files through mount-equivalent group,
 *    global, project, vault, and additional roots. Called ONLY when the
 *    caller (`runTurn`) has already determined this is a genuinely NEW
 *    session — since
 *    B4/LIA-404 that signal is REAL checkpointer-tuple existence
 *    (`priorTuple === undefined` for the outgoing thread_id), NOT the
 *    pre-B4 `sessionRef.session_id === ''` string check — literal
 *    once-per-session gating: it runs once when a new runtime session opens
 *    and never repeats for the same open lifecycle. A resumed turn (an
 *    existing checkpointer tuple) never calls this at all.
 *
 * 2. **Prompt lifecycle hook** (`buildPromptLifecycleHook`): ONE middleware,
 *    TWO hooks with split responsibilities:
 *    - `beforeModel` is PURELY observational — it pushes a
 *      `PromptEventRecord` on every firing, matching B2's established
 *      inspectable-log pattern, and NEVER touches `messages` or
 *      any field with ordering semantics. Returning `{messages: [systemMsg]}`
 *      from `beforeModel` would merge through LangGraph's default `messages`
 *      reducer, which APPENDS — the system message would land AFTER the
 *      user's message, and `@langchain/anthropic`'s real payload converter
 *      (`message_inputs.js`: "System messages are only permitted as the
 *      first passed message") would then THROW at runtime, invisible to
 *      `FakeToolCallingModel` tests.
 *    - `wrapModelCall` does the actual session-open injection via
 *      `request.systemMessage` — the type-designed mechanism (`ModelRequest`
 *      explicitly carries `systemPrompt?`/`systemMessage?` for exactly
 *      this), which `AgentNode` keeps in a field separate from `messages`,
 *      guaranteeing position-0 placement in the provider payload. The
 *      injection applies UNIFORMLY on every `wrapModelCall` firing within a
 *      turn where `sessionOpenMessage` is defined — deliberately NO
 *      first-firing-only gating: `AgentNode` resets the system message to
 *      the agent's base/empty value at the START of every internal
 *      model-decision cycle, so a first-firing-only injection would silently
 *      drop the content on any follow-up/final model call after a tool use
 *      within the SAME turn.
 *
 * No in-process session tracking of any kind lives in this module — the
 * new-vs-resumed decision is made ONCE per call by `runTurn` reading its own
 * (now correctly populated) `sessionRef` parameter, and that one decision
 * governs whether `loadSessionOpenContext` is even called.
 *
 * Turn-complete processing is NOT here: `deus-native-backend.ts`'s `runTurn`
 * already emits the `turn_complete` `RuntimeEvent` unconditionally on
 * success (shipped B1 behavior) — B3 adds a regression test for it, not new
 * production code.
 */

import {
  createMiddleware,
  SystemMessage,
  type AgentMiddleware,
} from 'langchain';

import type { RunContext } from './types.js';
import type { RegisteredGroup } from '../types.js';
import { loadRegisteredContextFiles } from './context-registry.js';
import { loadVaultContext, type VaultContextRecord } from './vault-context.js';

/**
 * One inspectable record per session-open event, matching the
 * observe-and-record idiom already used by `ToolCallDecisionRecord`/
 * `MemoryPassRecord`/`ModelCallRecord` in `middleware-stack.ts`.
 */
export interface SessionOpenRecord {
  /** Always true when produced — loadSessionOpenContext is only called on a
   *  genuinely new session open. */
  sessionOpened: boolean;
  /** Whether `groups/<folder>/CLAUDE.md` existed with non-empty content. */
  groupClaudeMdLoaded: boolean;
  /** Whether `groups/global/CLAUDE.md` was included (non-control groups
   *  only, and only when present with non-empty content). */
  globalClaudeMdLoaded: boolean;
  /** Ordered registry labels only — instruction contents are never retained
   *  in lifecycle metadata. */
  registeredContextLabels: string[];
  /** LIA-416 (D2): outcome metadata from the vault-context surface —
   *  eligibility/skip reason, vault availability, and WHICH ordered sections
   *  and configured filenames contributed. Identifiers and booleans only,
   *  never vault contents. */
  vaultContext: VaultContextRecord;
  timestamp: number;
}

/**
 * Loads the session-open context for a genuinely NEW session (the caller —
 * `runTurn` — decides that via checkpointer-tuple existence; this function is
 * never called on a resumed turn). Joins the present parts into one
 * system-role message string, or returns `undefined` when none exists —
 * session-open injection is gated on CONTENT PRESENCE as well as
 * new-vs-resumed status.
 *
 * Composition order is D2's existing vault aggregate first, followed by D4
 * registry blocks in fixed group/global/project/vault/additional order. The
 * D2 content and registry blocks already carry their own `=== ... ===`
 * headers, so no wrapper header is added.
 *
 * Async solely because the D2 vault pipeline's recent-sessions provider
 * spawns `memory_indexer.py` asynchronously. Registry reads are synchronous,
 * shallow, bounded, and fail-soft. Persona, `MEMORY_TREE.md`, solution atoms,
 * and broader memory surfaces remain outside D4.
 */
export async function loadSessionOpenContext(
  runContext: RunContext,
  group: RegisteredGroup | undefined,
): Promise<{
  systemMessage: string | undefined;
  record: SessionOpenRecord;
}> {
  const parts: string[] = [];

  // Vault context FIRST (most general). The facade owns ALL eligibility/
  // skip/fail-soft semantics — here it is one awaited call whose content is
  // included only when non-empty, exactly like the file parts below.
  const vault = await loadVaultContext(runContext);
  if (vault.content !== undefined) {
    parts.push(vault.content);
  }

  const registered = loadRegisteredContextFiles(
    runContext,
    group,
    vault.record,
  );
  parts.push(...registered.map(({ block }) => block));
  const registeredContextLabels = registered.map(({ label }) => label);

  return {
    systemMessage: parts.length > 0 ? parts.join('\n\n') : undefined,
    record: {
      sessionOpened: true,
      groupClaudeMdLoaded: registeredContextLabels.includes(
        'GROUP RULES: CLAUDE.md',
      ),
      globalClaudeMdLoaded: registeredContextLabels.includes(
        'GLOBAL RULES: CLAUDE.md',
      ),
      registeredContextLabels,
      vaultContext: vault.record,
      timestamp: Date.now(),
    },
  };
}

/** One record per submitted prompt / model-decision cycle. */
export interface PromptEventRecord {
  /** Character length of the latest message's string content at the time
   *  the model call was about to run (0 when the content is not a plain
   *  string) — enough for "event-context availability" without copying
   *  message bodies into the log. */
  promptLength: number;
  timestamp: number;
}

/**
 * Builds the B3 prompt-lifecycle middleware — see the module doc comment for
 * the two hooks' split responsibilities and the reasoning behind the
 * `wrapModelCall`/`systemMessage` injection mechanism.
 *
 * `sessionOpenMessage` is either defined for the WHOLE turn or undefined for
 * the whole turn — decided once by the caller (`runTurn`), and the hook
 * applies that decision uniformly on every firing (no per-firing state).
 */
export function buildPromptLifecycleHook(
  sessionOpenMessage: string | undefined,
  records: PromptEventRecord[],
): AgentMiddleware {
  return createMiddleware({
    name: 'prompt-lifecycle',
    // Observation only — NEVER touches `messages` (see module doc comment
    // for why a beforeModel messages-return cannot correctly prepend a
    // system message). Fires once per model-decision cycle, i.e. per
    // submitted prompt reaching the model.
    beforeModel: (state) => {
      const last = state.messages[state.messages.length - 1];
      records.push({
        promptLength:
          typeof last?.content === 'string' ? last.content.length : 0,
        timestamp: Date.now(),
      });
    },
    // The actual session-open injection. Applied on EVERY firing within the
    // turn when sessionOpenMessage is defined — AgentNode resets the system
    // message at the start of every internal model-decision cycle, so
    // anything less than every-firing application silently drops the content
    // on the model's final answer after a tool call.
    wrapModelCall: (request, handler) => {
      if (sessionOpenMessage === undefined) {
        return handler(request);
      }
      return handler({
        ...request,
        systemMessage: new SystemMessage(sessionOpenMessage),
      });
    },
  });
}
