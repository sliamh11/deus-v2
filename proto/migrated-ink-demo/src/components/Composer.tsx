// LIA-495 — Ink equivalent of web-first-demo's Composer/ComposerRow, itself
// ported from full-shell.tsx's ComposerRow. Same reasoning for hiding the
// real input while a permission decision is pending: the library has no
// cross-component focus management (no Dialog/Modal primitive on either
// target), so ComposerPrimitive.Input's own key handling stays live even
// while PermissionToolUI's chooser is open — on Ink, ComposerPrimitive.
// Input wires a real `TextInput` (ink's own per-keystroke `useInput`
// reducer, confirmed by reading ComposerInput.js), so a stray "1"/"2"/"3"/
// Enter keystroke would land in BOTH PermissionToolUI's useInput and the
// composer's text buffer simultaneously if the composer stayed mounted.
// Not rendering the real input at all while awaiting approval avoids that
// bleed, restored verbatim from full-shell.tsx's own ComposerRow.
import type { FC } from "react";
import { Box, Text } from "ink";
import { ComposerPrimitive } from "@assistant-ui/react-ink";
import { useShellStatus } from "../runtime/hooks";
import { tokens } from "../runtime/tokens";

export const ComposerRow: FC = () => {
  const status = useShellStatus();
  if (status === "awaiting approval") {
    return (
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>&gt; </Text>
        <Text color={tokens.semanticWarning} dimColor>
          Resolve the permission prompt above to continue…
        </Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color={tokens.textMuted}>&gt; </Text>
      <ComposerPrimitive.Input submitOnEnter placeholder="Ask Deus to do something…" autoFocus />
    </Box>
  );
};
