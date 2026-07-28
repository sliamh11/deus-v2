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
import type { ChatModelRunResult, ThreadAssistantMessagePart } from "@assistant-ui/core";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function* streamTextPart(
  parts: ThreadAssistantMessagePart[],
  full: string,
  partType: "text" | "reasoning" = "text",
  opts?: { chunkSize?: number; delayMs?: number },
): AsyncGenerator<readonly ThreadAssistantMessagePart[]> {
  const chunkSize = opts?.chunkSize ?? 3;
  const delayMs = opts?.delayMs ?? 26;
  let acc = "";
  for (let i = 0; i < full.length; i += chunkSize) {
    acc += full.slice(i, i + chunkSize);
    parts[parts.length - 1] =
      partType === "reasoning" ? { type: "reasoning", text: acc } : { type: "text", text: acc };
    yield [...parts];
    await sleep(delayMs);
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
export type ThreadScript = {
  start(turnIndex: number): AsyncGenerator<ChatModelRunResult>;
  continuations: Record<string, (approval: ResolvedApproval) => AsyncGenerator<ChatModelRunResult>>;
};
