// LIA-496 — rendered via `ThreadPrimitive.Empty` inside App.tsx (this
// target has no separate `Thread.tsx` — App.tsx's `ThreadPrimitive.Root`
// plays that role directly; confirm the wiring in App.tsx, not here).
// Keyboard-driven, no pointer affordances — matches a brand-new/unscripted
// thread's honest-fake intro (shared/src/fixtures/conversations.ts's
// `genericNewThreadTurn`), so the empty state and the first-turn reply read
// consistently rather than contradicting each other.
import type { FC } from "react";
import { Box, Text } from "ink";
import { theme, GLYPH_ASSISTANT, COMPOSER_PROMPT } from "../theme";

export const EmptyState: FC = () => (
  <Box flexDirection="column" paddingY={2} paddingX={1}>
    <Text color={theme.dim}>
      {GLYPH_ASSISTANT} No messages in this session yet.
    </Text>
    <Box marginTop={1}>
      <Text color={theme.dim}>
        Type after {"'"}
        <Text color={theme.amber}>{COMPOSER_PROMPT}</Text>
        {"'"} below and press enter to start, or ctrl+t (↑/↓ + enter) to open a seeded thread.
      </Text>
    </Box>
  </Box>
);
