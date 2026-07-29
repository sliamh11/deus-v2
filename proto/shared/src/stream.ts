// LIA-496 — generic scripted-turn machinery, factored out of adapter.ts so
// fixtures/conversations.ts (which needs it to build turns) and adapter.ts
// (which needs the `ThreadScript` shape to type its generic dispatcher, and
// imports `SCRIPTS` FROM fixtures/conversations.ts) don't form a runtime
// import cycle: this leaf module depends on neither.
//
// LIA-495's `streamTextPart`/`sleep`, ported verbatim (same growing-
// snapshot contract: local-thread-runtime-core.js concatenates each
// yield's `content` onto the content this run() step started with, not
// the previous yield's, so every yield here re-supplies the FULL set of
// parts produced so far in this run() call). Types imported directly from
// "@assistant-ui/core" (not either target's own DOM/terminal React
// binding package) — this is what makes the shared package genuinely
// target-blind rather than per-target-duplicated, per the S1 dispatch.
//
// WB1 (LIA-496 review-fix) — abortSignal threading, added here. Verified
// directly against node_modules/@assistant-ui/core/dist/runtimes/local/
// local-thread-runtime-core.js:353-362: the consumer's `for await` loop
// only checks `abortSignal.aborted` AFTER receiving each yielded value
// (discarding that one value and breaking), so a `sleep(...)` awaited
// between two yields with no abort-awareness of its own fully elapses
// (up to ~620ms in these scripts) before the generator reaches the next
// yield to even be checked — that's the "Stop renders inert, doesn't
// actually halt output promptly" gap. `sleep` now resolves as soon as
// EITHER the timer fires OR the signal aborts, and every generator in
// fixtures/conversations.ts checks `signal?.aborted` immediately after
// each `await sleep(...)`/streamTextPart loop to `return` before doing any
// further (possibly side-effecting, e.g. applyDelete/grant) work or
// yielding again. Logic-only — no presentation value, no target-specific
// import; check-shared-purity.sh has no pattern this touches.
//
// WB1 REVISE round (LIA-496 code-review, orchestrator-sanctioned as part of
// this revise dispatch — extends the shared-change list above beyond
// abortSignal-only) — empty-but-running initial yield. Before this fix,
// `streamTextPart`'s very first loop iteration already appended the first
// `chunkSize` characters before its first `yield`, so the DOM never saw a
// genuinely-empty-but-`isRunning` snapshot: MarkdownText.tsx/Thread.tsx's
// `if (!text) return isRunning ? <shimmer/> : null` shimmer branch is
// correctly coded but was unreachable dead code against every fixture in
// this file (W2 finding, WB1 REVISE round). Every call site already pushes
// an empty part (`{ type, text: "" }`) onto `parts` immediately before
// calling `streamTextPart` (see e.g. `turn1Start`'s initial
// `[{ type: "reasoning", text: "" }]` and every `parts.push({ type: "text",
// text: "" })` in fixtures/conversations.ts), so `parts[parts.length - 1]`
// is already that empty part when this generator starts — yielding it
// as-is (no snapshot mutation) before consuming any chunks, plus one
// `sleep` tick, makes the empty-and-running state real and DOM-observable
// for the shimmer to key off, without changing the growing-snapshot
// contract described above.
import type { ChatModelRunResult, ThreadAssistantMessagePart } from "@assistant-ui/core";

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function* streamTextPart(
  parts: ThreadAssistantMessagePart[],
  full: string,
  partType: "text" | "reasoning" = "text",
  opts?: { chunkSize?: number; delayMs?: number; signal?: AbortSignal },
): AsyncGenerator<readonly ThreadAssistantMessagePart[]> {
  const chunkSize = opts?.chunkSize ?? 3;
  const delayMs = opts?.delayMs ?? 26;
  const signal = opts?.signal;
  let acc = "";

  // Empty-but-running yield (WB1 REVISE round — see header comment): the
  // just-pushed empty part, unmodified, before any chunk is consumed.
  if (signal?.aborted) return;
  yield [...parts];
  await sleep(delayMs, signal);
  if (signal?.aborted) return;

  for (let i = 0; i < full.length; i += chunkSize) {
    if (signal?.aborted) return;
    acc += full.slice(i, i + chunkSize);
    parts[parts.length - 1] =
      partType === "reasoning" ? { type: "reasoning", text: acc } : { type: "text", text: acc };
    yield [...parts];
    await sleep(delayMs, signal);
  }
}

// The Edit tool's result shape, ported verbatim from LIA-495's adapter.ts.
export type EditDiffResult = { type: "diff"; diffContent: string; filename: string };

// A resolved approval, as handed to a `ThreadScript`'s continuation for a
// given toolCallId once the human has decided.
export type ResolvedApproval = { approved: boolean; optionId: string | undefined };

// A single thread's scripted conversation. `start` is invoked once per new
// user turn (turnIndex is 1-based and increments once per call); a thread
// with N user messages needs `start` to handle turnIndex 1..N.
// `continuations` maps a tool-call's `toolCallId` to the generator that
// resumes the run once that call's approval has been resolved — only
// needed for tool calls that were built WITH an `approval` field.
//
// `signal`, added for WB1's abortSignal threading (see this file's header
// comment): optional so a caller with no cancellation concept (e.g. the
// headless verification script) can still invoke `start`/a continuation
// directly without constructing an AbortController.
export type ThreadScript = {
  start(turnIndex: number, signal?: AbortSignal): AsyncGenerator<ChatModelRunResult>;
  continuations: Record<
    string,
    (approval: ResolvedApproval, signal?: AbortSignal) => AsyncGenerator<ChatModelRunResult>
  >;
};
