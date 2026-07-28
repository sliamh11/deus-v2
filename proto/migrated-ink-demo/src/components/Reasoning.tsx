// LIA-495 — Ink equivalent of web-first-demo's Reasoning
// (ReasoningPartUI/ReasoningGroupUI), itself ported from full-shell.tsx.
// `ReasoningGroupComponent`/`ReasoningMessagePartProps` are the ONE
// tui-v2 surface confirmed to exist unchanged on both targets (exported as
// a type from @assistant-ui/core, re-exported unchanged by both
// @assistant-ui/react and @assistant-ui/react-ink) — so unlike DiffPanel/
// TasksFooter this is a genuine two-way port, not a hand-built substitute
// on either side. Only the markup changed back (DOM `<div>`/CSS border →
// Ink `<Box borderStyle="round">`, matching full-shell.tsx exactly).
import type { FC } from "react";
import { Box, Text } from "ink";
import { useAuiState, type ReasoningGroupComponent, type ReasoningMessagePartProps } from "@assistant-ui/react-ink";
import { BULLET, tokens } from "../runtime/tokens";

export const ReasoningPartUI: FC<ReasoningMessagePartProps> = (props) => (
  <Text color={tokens.textMuted} italic>
    {props.text}
  </Text>
);

export const ReasoningGroupUI: ReasoningGroupComponent = ({ endIndex, children }) => {
  // Same real, observed per-part status read as full-shell.tsx's/
  // web-first-demo's ReasoningGroupUI (PartState.status), so the label
  // genuinely reflects "still streaming" vs. "settled" instead of a
  // constant string.
  const stillStreaming = useAuiState((s) => s.message.parts[endIndex]?.status?.type === "running");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.textMuted} paddingX={1} marginBottom={1}>
      <Text bold color={tokens.accentInfo}>
        {BULLET} {stillStreaming ? "Thinking…" : "Thought"}
      </Text>
      <Box flexDirection="column" marginTop={0}>
        {children}
      </Box>
    </Box>
  );
};
