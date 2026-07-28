// LIA-495 — the ChatModelAdapter and scripted-turn generators, ported from
// full-shell.tsx's "Streaming helper" / "The scripted conversation" /
// `adapter` sections. This is the file the whole ticket is really about:
// everything below is UNCHANGED runtime/session logic — same streaming
// contract, same turn structure, same state-keyed branching (never keyed
// off literal user text) — because `ChatModelAdapter`, `ChatModelRunResult`,
// and `ThreadAssistantMessagePart` are defined once in the backend-neutral
// `@assistant-ui/core` and re-exported unchanged by both
// `@assistant-ui/react` and `@assistant-ui/react-ink`. Nothing here imports
// ink or the DOM.
import type { ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react-ink";
import type { ThreadAssistantMessagePart } from "@assistant-ui/core";
import { sleep } from "./tokens";
import { PERMISSION_OPTIONS } from "./permissions";
import {
  CHECK_COMMAND,
  EDIT_PATH,
  SCRATCH_PATH,
  STATUS_GLYPH_PATCH,
  VERIFY_COMMAND,
} from "./fixtures";
import { existsSync } from "./virtualFs";

export type EditDiffResult = { type: "diff"; diffContent: string; filename: string };

// ---------------------------------------------------------------------------
// Streaming helper — identical growing-snapshot contract to full-shell.tsx's
// streamTextPart: local-thread-runtime-core.js concatenates each yield's
// `content` onto the content this run() step started with (not the
// previous yield's), so every yield here re-supplies the FULL set of parts
// produced so far in this run() call — same as the ink version, because
// that contract lives in @assistant-ui/core's local-runtime, not in
// react-ink.
// ---------------------------------------------------------------------------
async function* streamTextPart(
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

// ---------------------------------------------------------------------------
// The scripted conversation — ported verbatim (same fixture paths/commands,
// same turn shape, same "reason: tool-calls not interrupt" choice that lets
// respondToApproval's shouldContinue check auto-resume the turn) from
// full-shell.tsx's turn1Start/turn1Continue/turn2.
//
// Suggested script for whoever drives the capture (same as the ink version):
//   Turn 1: "Clean up that stale scratch log in /tmp, then tighten the
//            status-glyph comment in ToolMessage.tsx to use the ⏺ convention."
//   → resolve the inline permission prompt (any of the three options)
//   Turn 2: "Did that leave anything else stale in /tmp?"
// ---------------------------------------------------------------------------
async function* turn1Start(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "reasoning", text: "" }];

  for await (const snap of streamTextPart(
    parts,
    "Two asks here: clean up a stale scratch file, and tighten a status-glyph comment. Deleting a file is destructive, so I should confirm it actually exists before proposing anything — and either way I'll need explicit permission before removing it.",
    "reasoning",
  )) {
    yield { content: snap };
  }
  await sleep(180);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(
    parts,
    "I'll handle both of those. Let me first check on that scratch file.",
  )) {
    yield { content: snap };
  }
  await sleep(220);

  parts.push({
    type: "tool-call",
    toolCallId: "call-check-scratch",
    toolName: "Bash",
    args: { command: CHECK_COMMAND },
    argsText: JSON.stringify({ command: CHECK_COMMAND }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(480);

  const checkResult = existsSync(SCRATCH_PATH)
    ? `-rw-r--r--  1 deus  staff  36 ${SCRATCH_PATH}`
    : "ls: no such file";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: checkResult, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(
    parts,
    "Found it — deleting it is a filesystem write, so I need your OK first.",
  )) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: "call-delete-scratch",
    toolName: "delete_file",
    args: { path: SCRATCH_PATH },
    argsText: JSON.stringify({ path: SCRATCH_PATH }),
    approval: { id: "appr-delete-scratch", options: PERMISSION_OPTIONS },
  } as ThreadAssistantMessagePart);
  // reason: "tool-calls" (not "interrupt") — this is what lets
  // respondToApproval's shouldContinue check auto-resume this same turn
  // once the human decides, with no second user message needed. Same
  // finding full-shell.tsx documents at length in its header comment.
  yield { content: [...parts], status: { type: "requires-action", reason: "tool-calls" } };
}

async function* turn1Continue(approved: boolean): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];

  const intro = approved
    ? "Done — that's cleaned up. Now tightening the status-glyph comment in ToolMessage.tsx."
    : "Understood, I'll leave that file alone. Still tightening the status-glyph comment in ToolMessage.tsx.";
  for await (const snap of streamTextPart(parts, intro)) {
    yield { content: snap };
  }
  await sleep(220);

  parts.push({
    type: "tool-call",
    toolCallId: "call-edit-toolmessage",
    toolName: "Edit",
    args: { path: EDIT_PATH },
    argsText: JSON.stringify({ path: EDIT_PATH }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(620);

  const editResult: EditDiffResult = { type: "diff", diffContent: STATUS_GLYPH_PATCH, filename: EDIT_PATH };
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: editResult, isError: false };
  yield { content: [...parts] };
  await sleep(220);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "That's both done. Let me know if you'd like anything else.")) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

async function* turn2(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];

  for await (const snap of streamTextPart(parts, "Checking now.")) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: `call-verify-${Date.now()}`,
    toolName: "Bash",
    args: { command: VERIFY_COMMAND },
    argsText: JSON.stringify({ command: VERIFY_COMMAND }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(480);

  const remaining = existsSync(SCRATCH_PATH);
  const verifyResult = remaining ? SCRATCH_PATH.split("/").pop()! : "(no matches)";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: verifyResult, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  const closing = remaining
    ? "There's still one leftover file there from the earlier denial — otherwise clean."
    : "All clean — nothing else stale in /tmp.";
  for await (const snap of streamTextPart(parts, closing)) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

// Module-level turn counter — identical to full-shell.tsx's `turnIndex`.
// Kept module-scoped (not component state) so it survives across the
// adapter's repeated `run()` invocations the same way the ink version's
// did; `useLocalRuntime` calls the SAME adapter object across renders.
let turnIndex = 0;

export const adapter: ChatModelAdapter = {
  async *run(options) {
    const current = options.unstable_getMessage();
    const deleteCall = current.content.find(
      (c) => c.type === "tool-call" && c.toolName === "delete_file",
    ) as (ThreadAssistantMessagePart & { type: "tool-call" }) | undefined;
    const editCall = current.content.find((c) => c.type === "tool-call" && c.toolName === "Edit");

    if (!deleteCall) {
      turnIndex += 1;
      if (turnIndex === 1) {
        yield* turn1Start();
      } else {
        yield* turn2();
      }
      return;
    }

    if (deleteCall.approval?.approved !== undefined && !editCall) {
      yield* turn1Continue(deleteCall.approval.approved === true);
      return;
    }

    // Nothing further scripted for this state (e.g. a third message after
    // turn 2, or a re-entrant call this fixture doesn't otherwise expect).
    yield { content: [], status: { type: "complete", reason: "stop" } };
  },
};
