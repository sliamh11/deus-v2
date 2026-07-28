// LIA-495 — the second honest gap this port's setup stage flagged: the ink
// round-5 footer renders through the library's real
// `LiveChecklist`/`ChecklistPrimitive.{Root,Item,Progress}` family.
// `@assistant-ui/react` — the web package — has NO checklist primitive at
// all: grepping the entire @assistant-ui/ node_modules tree for
// "checklist" in any case returns zero matches outside react-ink. There is
// no ChecklistItemData, no LiveChecklist, nothing to import.
//
// So this footer is HAND-BUILT, not a port of a library component — same
// as full-shell.tsx's OWN pre-round-5 hand-drawn "Tasks n/total" footer
// (round 5 replaced that with LiveChecklist specifically because the
// library gained the primitive; the web target doesn't have it, so this
// reverts to that same hand-rolled shape, now as real DOM markup). The data
// feeding it is genuine, unchanged, observed thread/approval state: the
// SAME useApprovalTaskStatus/useToolTaskStatus hooks (runtime/hooks.ts,
// ported verbatim) drive both the ink and web footers.
import type { FC } from "react";
import { useApprovalTaskStatus, useToolTaskStatus, type TaskStatus } from "../runtime/hooks";
import { VERIFY_COMMAND } from "../runtime/fixtures";
import { tokens } from "../runtime/tokens";

function statusGlyph(status: TaskStatus): { glyph: string; color: string } {
  switch (status) {
    case "done":
      return { glyph: "■", color: tokens.semanticSuccess };
    case "blocked":
      return { glyph: "✕", color: tokens.semanticError };
    case "active":
      return { glyph: "◌", color: tokens.accentPrimary };
    case "pending":
      return { glyph: "□", color: tokens.textMuted };
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled TaskStatus: ${_exhaustive}`);
    }
  }
}

const TaskRow: FC<{ text: string; status: TaskStatus }> = ({ text, status }) => {
  const { glyph, color } = statusGlyph(status);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span className={status === "active" ? "cc-spinner-dot" : undefined} style={{ color }}>
        {glyph}
      </span>
      <span style={{ color: status === "done" ? tokens.textMuted : tokens.textPrimary }}>{text}</span>
    </div>
  );
};

export const TasksFooter: FC = () => {
  const cleanup = useApprovalTaskStatus("delete_file");
  const glyphEdit = useToolTaskStatus("Edit");
  const verify = useToolTaskStatus("Bash", VERIFY_COMMAND);
  const items: { id: string; text: string; status: TaskStatus }[] = [
    { id: "cleanup", text: "Clean up scratch file", status: cleanup },
    { id: "glyph-edit", text: "Tighten glyph comment", status: glyphEdit },
    { id: "verify", text: "Verify /tmp is clean", status: verify },
  ];
  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div
      style={{
        borderTop: `1px solid ${tokens.borderNeutral}`,
        marginTop: 16,
        paddingTop: 12,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6, color: tokens.textPrimary }}>Tasks</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item) => (
          <TaskRow key={item.id} text={item.text} status={item.status} />
        ))}
      </div>
      <div style={{ marginTop: 6, color: tokens.textMuted, fontSize: 12 }}>
        {doneCount}/{items.length} done
      </div>
    </div>
  );
};
