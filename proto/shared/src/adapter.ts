// LIA-495 -> LIA-496 — the ChatModelAdapter, generalized from LIA-495's
// single hardcoded module-level turn counter into a per-thread, memoized
// generic dispatcher so all 7 seeded threads (fixtures/threads.ts) can each
// run their own independent scripted conversation
// (fixtures/conversations.ts) through the SAME runtime/session logic:
// same streaming contract, same "state-keyed branching, never keyed off
// literal user text" rule LIA-495 established. Types come straight from
// "@assistant-ui/core" (not either target's own React binding package) —
// this is the change that makes this file genuinely one shared file
// instead of two per-target copies differing only by import specifier
// (LIA-495's adapter.ts/hooks.ts finding).
import type { ChatModelAdapter } from "@assistant-ui/core";
import { getScriptForThread } from "./fixtures/conversations";

// Memoized per threadId so turn state (turnIndex, which approvals have
// already been continued) survives across repeated `getFixtureAdapter`
// calls for the same thread — required for "switching threads and back
// preserves live-created messages" to also mean "and doesn't replay turn
// 1 when you come back". Callers (S2A/S2B's `runtimeHook`) do not need to
// memoize this themselves; calling it again for the same threadId is safe
// and returns the identical adapter instance.
const adapters = new Map<string, ChatModelAdapter>();

export function getFixtureAdapter(threadId: string): ChatModelAdapter {
  const existing = adapters.get(threadId);
  if (existing) return existing;

  // Falls back to a generic honest-fake script for a thread id not in
  // fixtures/conversations.ts's SCRIPTS (e.g. a brand-new thread the user
  // just started) rather than throwing — see that fallback's own comment.
  const script = getScriptForThread(threadId);

  let turnIndex = 0;
  // toolCallIds whose approval this adapter has already resumed from —
  // without this, a resolved approval that's still present in
  // `current.content` on a LATER run() call (e.g. the run() invocation
  // that starts the NEXT user turn) would be mistaken for a fresh
  // continuation and re-run the same continuation generator again.
  const handledApprovals = new Set<string>();

  const adapter: ChatModelAdapter = {
    async *run(options) {
      const { abortSignal } = options;
      const current = options.unstable_getMessage();
      const pendingApproval = current.content.find(
        (c) =>
          c.type === "tool-call" &&
          c.approval !== undefined &&
          c.approval.approved !== undefined &&
          !handledApprovals.has(c.toolCallId),
      );

      if (pendingApproval && pendingApproval.type === "tool-call" && pendingApproval.approval) {
        handledApprovals.add(pendingApproval.toolCallId);
        const continuation = script.continuations[pendingApproval.toolCallId];
        if (continuation) {
          // WB1 — abortSignal threaded through so a continuation's own
          // sleeps/streamTextPart calls can halt promptly on Stop, same as
          // `start` below (see stream.ts's header comment for the
          // mechanism this fixes).
          yield* continuation(
            {
              approved: pendingApproval.approval.approved === true,
              optionId: pendingApproval.approval.optionId,
            },
            abortSignal,
          );
          return;
        }
        // A resolved approval with no registered continuation is not
        // expected for any scripted thread — fall through to `start` only
        // as a last resort so an unscripted state doesn't hang the UI.
      }

      turnIndex += 1;
      yield* script.start(turnIndex, abortSignal);
    },
  };

  adapters.set(threadId, adapter);
  return adapter;
}

// Exposed for the headless verification script (and any future "reset
// session" affordance) so a fresh run can be exercised without restarting
// the process. Never called from the scripted turn generators themselves.
export function resetFixtureAdapters(): void {
  adapters.clear();
}
