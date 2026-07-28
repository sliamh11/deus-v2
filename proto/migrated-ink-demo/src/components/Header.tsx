// LIA-495 — Ink equivalent of web-first-demo's Header (itself ported from
// full-shell.tsx's Header). Same status derivation (runtime/hooks.ts's
// useShellStatus, copied verbatim from web-first-demo), same three-state
// color mapping — a DOM `<div>` with a CSS bottom border becomes an Ink
// `<Box borderBottom>`.
import type { FC } from "react";
import { Box, Text } from "ink";
import { useShellStatus } from "../runtime/hooks";
import { BULLET, tokens } from "../runtime/tokens";

export const Header: FC = () => {
  const status = useShellStatus();
  const color =
    status === "working"
      ? tokens.accentPrimary
      : status === "awaiting approval"
        ? tokens.semanticWarning
        : tokens.textMuted;
  const label =
    status === "working" ? "Working" : status === "awaiting approval" ? "Awaiting approval" : "Idle";

  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderNeutral}
      marginBottom={1}
    >
      <Text bold color={tokens.textPrimary}>
        deus-v2-mvp
      </Text>
      <Text color={tokens.textMuted}> · full-shell-demo (LIA-495) · </Text>
      <Text color={color}>
        {BULLET} {label}
      </Text>
    </Box>
  );
};
