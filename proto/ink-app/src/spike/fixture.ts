// LIA-496 IB1 — SPIKE-ONLY scratch fixture, not wired into the real app.
// One real multi-part assistant turn covering the full range of leaf
// components constraint 3 names: a text part (-> MarkdownText), a plain
// tool-call part (Bash -> BashLine, the Fallback renderer), and a
// permission part (delete_file -> PermissionPrompt), the permission
// already RESOLVED (approved=true) so it exercises PermissionPrompt's
// "resolved-line" branch specifically named in the plan's Approach A
// description — a committed/historical message would already be resolved,
// never mid-prompt.
import type { ThreadMessageLike } from "@assistant-ui/react-ink";
import { executionOutcomes } from "@lia496/shared";

export const TOOL_CALL_ID_BASH = "spike_call_bash_1";
export const TOOL_CALL_ID_DELETE = "spike_call_delete_1";

// PermissionPrompt's ResolvedLine reads this map to render the real
// executed-outcome text ("deleted") instead of "awaiting execution" — same
// mechanism the real app uses (shared/src/permissions.ts's header comment).
executionOutcomes.set(TOOL_CALL_ID_DELETE, true);

export const SPIKE_USER_MESSAGE: ThreadMessageLike = {
  role: "user",
  content: "Check whether config/old.json is still referenced anywhere, then delete it if it's dead.",
};

export const SPIKE_ASSISTANT_MESSAGE: ThreadMessageLike = {
  role: "assistant",
  status: { type: "complete", reason: "stop" },
  content: [
    {
      type: "text",
      text:
        "I checked the repo for references before touching anything.\n\n" +
        "- last modified 40 days ago\n" +
        "- not imported by any active module\n\n" +
        "Deleting the stale file now.",
    },
    {
      type: "tool-call",
      toolCallId: TOOL_CALL_ID_BASH,
      toolName: "Bash",
      args: { command: "grep -r config/old.json src/" },
      argsText: '{"command":"grep -r config/old.json src/"}',
      result: "no matches found",
      isError: false,
    },
    {
      type: "tool-call",
      toolCallId: TOOL_CALL_ID_DELETE,
      toolName: "delete_file",
      args: { path: "config/old.json" },
      argsText: '{"path":"config/old.json"}',
      approval: {
        id: "spike_approval_1",
        approved: true,
        optionId: "allow_once",
      },
    },
  ],
};

export const SPIKE_INITIAL_MESSAGES: ThreadMessageLike[] = [SPIKE_USER_MESSAGE, SPIKE_ASSISTANT_MESSAGE];

// A distinctive literal string planted in the FIRST message — reused by
// later scrollback-preservation proofs (constraint above) to grep for
// content-identity, not just line count. Not needed by this spike's own
// PASS criterion (single render, no thread switch) but kept here so it's
// the one place this literal is defined.
export const SPIKE_IDENTITY_STRING = "config/old.json";
