// LIA-495 — ported from full-shell.tsx's ReasoningPartUI/ReasoningGroupUI.
// `ReasoningGroupComponent`/`ReasoningMessagePartProps` are the ONE tui-v2
// surface the setup stage confirmed exists on both targets (exported as a
// type from @assistant-ui/core/react, re-exported unchanged by both
// @assistant-ui/react and @assistant-ui/react-ink) — so unlike DiffPanel/
// TasksFooter this is a genuine port, not a hand-built substitute. Only the
// markup changed (Ink `<Box borderStyle="round">` → a `<div>` with a CSS
// border).
import type { FC } from "react";
import { useAuiState, type ReasoningGroupComponent, type ReasoningMessagePartProps } from "@assistant-ui/react";
import { BULLET, tokens } from "../runtime/tokens";

export const ReasoningPartUI: FC<ReasoningMessagePartProps> = (props) => (
  <span style={{ color: tokens.textMuted, fontStyle: "italic" }}>{props.text}</span>
);

export const ReasoningGroupUI: ReasoningGroupComponent = ({ endIndex, children }) => {
  // Same real, observed per-part status read as full-shell.tsx's
  // ReasoningGroupUI (PartState.status), so the label genuinely reflects
  // "still streaming" vs. "settled" instead of a constant string.
  const stillStreaming = useAuiState((s) => s.message.parts[endIndex]?.status?.type === "running");
  return (
    <div
      style={{
        border: `1px solid ${tokens.textMuted}`,
        borderRadius: 6,
        padding: "8px 12px",
        marginBottom: 16,
      }}
    >
      <div style={{ fontWeight: 700, color: tokens.accentInfo }}>
        {BULLET} {stillStreaming ? "Thinking…" : "Thought"}
      </div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
};
