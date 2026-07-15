/**
 * Runtime lifecycle events for the `deus-native` runtime (LIA-403 / B3).
 *
 * Parallel in spirit to `middleware-stack.ts` (B2) but scoped to
 * `runTurn`-level LIFECYCLE (session-open / per-prompt / turn-complete), not
 * tool/model-call middleware substance. Two concerns live here:
 *
 * 1. **Session-open context loading** (`loadSessionOpenContext`): reads the
 *    group's own `groups/<folder>/CLAUDE.md` (and `groups/global/CLAUDE.md`
 *    for non-control groups, mirroring the container path's own main-vs-other
 *    distinction — `container-mounter.ts` mounts `/workspace/global`
 *    read-only only for non-main groups, and the container-side reader is
 *    `context-registry.ts`'s `GLOBAL RULES: CLAUDE.md` entry with
 *    `skipForControlGroup: true`). Called ONLY when the caller (`runTurn`)
 *    has already determined this is a genuinely NEW session
 *    (`sessionRef.session_id === ''`) — literal once-per-session gating: it
 *    runs once when a new runtime session opens and never repeats for the
 *    same open lifecycle. A resumed turn never calls this at all.
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

import fs from 'fs';
import path from 'path';

import {
  createMiddleware,
  SystemMessage,
  type AgentMiddleware,
} from 'langchain';

import type { RunContext } from './types.js';
import { resolveGroupFolderPath } from '../group-folder.js';

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
  timestamp: number;
}

/**
 * Reads a file if present, returning its content only when it is non-empty
 * after trimming. Never throws on a missing file — matches every other
 * file-presence check in this codebase (sync read, matching
 * `context-registry.ts`'s own sync-read convention).
 */
function readContextFileIfPresent(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().length > 0 ? content : undefined;
}

/**
 * Loads the session-open context for a genuinely NEW session (the caller —
 * `runTurn` — decides that; this function is never called on a resumed
 * turn). Joins the present files into one system-role message string, or
 * returns `undefined` when neither exists — session-open injection is gated
 * on CONTENT PRESENCE as well as new-vs-resumed status.
 *
 * Scope is deliberately group-scoped CLAUDE.md ONLY: `groups/<folder>/` is
 * the real, group-scoped source the container path bind-mounts as
 * `/workspace/group`, so reading it for THAT group's own session cannot leak
 * into another group's session. `groups/global/CLAUDE.md` is deliberately
 * shared across all non-main groups by the EXISTING container path's own
 * design — an existing pattern mirrored, not a new risk. AGENTS.md/
 * AI_AGENT_GUIDELINES.md/persona context and full `context-registry.ts`
 * parity stay explicitly out of scope (see deus-native-backend.ts's
 * non-goals).
 */
export function loadSessionOpenContext(runContext: RunContext): {
  systemMessage: string | undefined;
  record: SessionOpenRecord;
} {
  // Reused, not reimplemented: path-traversal-safe by construction
  // (ensureWithinBase inside group-folder.ts).
  const groupDir = resolveGroupFolderPath(runContext.groupFolder);
  const parts: string[] = [];
  let globalClaudeMdLoaded = false;
  let groupClaudeMdLoaded = false;

  // Global rules first (general), group rules second (specific) — non-control
  // groups only, mirroring container-mounter.ts's main-vs-other mounting
  // distinction. 'global' is a RESERVED folder name that
  // resolveGroupFolderPath refuses by design, so resolve it as the group
  // dir's sibling (both live directly under the groups base dir).
  if (!runContext.isControlGroup) {
    const globalContent = readContextFileIfPresent(
      path.join(path.dirname(groupDir), 'global', 'CLAUDE.md'),
    );
    if (globalContent !== undefined) {
      parts.push(`GLOBAL RULES: CLAUDE.md\n\n${globalContent}`);
      globalClaudeMdLoaded = true;
    }
  }

  const groupContent = readContextFileIfPresent(
    path.join(groupDir, 'CLAUDE.md'),
  );
  if (groupContent !== undefined) {
    parts.push(`GROUP RULES: CLAUDE.md\n\n${groupContent}`);
    groupClaudeMdLoaded = true;
  }

  return {
    systemMessage: parts.length > 0 ? parts.join('\n\n') : undefined,
    record: {
      sessionOpened: true,
      groupClaudeMdLoaded,
      globalClaudeMdLoaded,
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
