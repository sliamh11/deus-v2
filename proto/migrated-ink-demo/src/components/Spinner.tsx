// LIA-495 — Ink equivalent of web-first-demo's Spinner/ActiveStatusRow
// (itself ported from full-shell.tsx). The Ink target can use the
// library's OWN `LoadingPrimitive.Spinner` (ink-spinner "dots" under the
// hood) for the glyph — web-first-demo had to hand-roll a CSS `@keyframes`
// substitute only because that primitive is confirmed absent from
// @assistant-ui/react's web export. Restored to full-shell.tsx's original
// mechanism. The rotating-gerund WORD logic is unchanged either way — same
// useRotatingGerund hook (runtime/hooks.ts, copied verbatim), same word
// list (runtime/tokens.ts's GERUND_WORDS), same 950ms cadence — since that
// part was always hand-rolled (no word-rotation primitive exists in
// either package).
import type { FC } from "react";
import { Box, Text } from "ink";
import { LoadingPrimitive } from "@assistant-ui/react-ink";
import { useRotatingGerund } from "../runtime/hooks";
import { tokens } from "../runtime/tokens";

export const ActiveStatusRow: FC = () => {
  const word = useRotatingGerund();
  return (
    <Box marginBottom={1}>
      <Text color={tokens.accentPrimary}>
        <LoadingPrimitive.Spinner type="dots" />
      </Text>
      <Text color={tokens.accentPrimary}> {word}…</Text>
    </Box>
  );
};
