// LIA-495 — the mirror image of web-first-demo's TasksFooter gap. On the
// web target, @assistant-ui/react has no checklist primitive at all, so
// web-first-demo hand-built a "Tasks n/total" footer. On the Ink target,
// @assistant-ui/react-ink DOES export a real `LiveChecklist`/
// `ChecklistPrimitive.{Root,Item,Progress}` family (confirmed live in
// full-shell.tsx's round-5 footer) — so this is a genuine library-primitive
// port, not a hand-built substitute. The data feeding it is unchanged: the
// SAME useApprovalTaskStatus/useToolTaskStatus hooks (runtime/hooks.ts,
// copied verbatim) that drove both full-shell.tsx's and web-first-demo's
// footers drive this one too — only the render target changed back to the
// library's real ChecklistItemData/LiveChecklist shape (checklistStatus
// below maps this fixture's own TaskStatus onto the library's
// ChecklistItemStatus vocabulary, restored verbatim from full-shell.tsx).
//
// Deliberately passes an explicit `items` array rather than relying on
// LiveChecklist's own auto-derivation (`useToolCallChecklist`/
// `AutoChecklist`, used when `items` is omitted): that hook reads only
// `s.message.parts` of the CURRENT message, i.e. one turn's tool calls,
// whereas this footer's three tasks span BOTH scripted turns — same
// reasoning as full-shell.tsx's round-5 header comment.
import type { FC } from "react";
import { Box } from "ink";
import { LiveChecklist, type ChecklistItemData, type ChecklistItemStatus } from "@assistant-ui/react-ink";
import { useApprovalTaskStatus, useToolTaskStatus, type TaskStatus } from "../runtime/hooks";
import { VERIFY_COMMAND } from "../runtime/fixtures";
import { tokens } from "../runtime/tokens";

function checklistStatus(status: TaskStatus): ChecklistItemStatus {
  switch (status) {
    case "done":
      return "complete";
    case "blocked":
      return "error";
    case "active":
      return "running";
    case "pending":
      return "pending";
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled TaskStatus: ${_exhaustive}`);
    }
  }
}

export const TasksFooter: FC = () => {
  const cleanup = useApprovalTaskStatus("delete_file");
  const glyphEdit = useToolTaskStatus("Edit");
  const verify = useToolTaskStatus("Bash", VERIFY_COMMAND);
  const items: ChecklistItemData[] = [
    { id: "cleanup", text: "Clean up scratch file", status: checklistStatus(cleanup) },
    { id: "glyph-edit", text: "Tighten glyph comment", status: checklistStatus(glyphEdit) },
    { id: "verify", text: "Verify /tmp is clean", status: checklistStatus(verify) },
  ];
  return (
    <Box
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderNeutral}
      marginTop={1}
      paddingTop={0}
    >
      <LiveChecklist items={items} title="Tasks" showProgress />
    </Box>
  );
};
