// LIA-495 — ported from full-shell.tsx's ComposerRow. Same reasoning for
// hiding the real input while a permission decision is pending: the
// library has no cross-component focus management (no Dialog/Modal
// primitive on either target), so ComposerPrimitive.Input's own key
// handling stays live even while PermissionToolUI's chooser is open. On
// the web target the concrete risk is a stray "1"/"2"/"3"/Enter keystroke
// landing in the composer's `<textarea>` instead of (or in addition to)
// PermissionToolUI's onKeyDown — same class of bleed the ink version's
// comment describes for Ink's useInput, just DOM focus instead of a raw
// keypress reducer. Not rendering the real input at all while awaiting
// approval avoids it.
import type { FC } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import { useShellStatus } from "../runtime/hooks";
import { tokens } from "../runtime/tokens";

export const ComposerRow: FC = () => {
  const status = useShellStatus();
  if (status === "awaiting approval") {
    return (
      <div style={{ marginTop: 16, display: "flex", gap: 6 }}>
        <span style={{ color: tokens.textMuted }}>{"> "}</span>
        <span style={{ color: tokens.semanticWarning, opacity: 0.85 }}>
          Resolve the permission prompt above to continue…
        </span>
      </div>
    );
  }
  return (
    <ComposerPrimitive.Root
      style={{ marginTop: 16, display: "flex", gap: 6, alignItems: "flex-start" }}
    >
      <span style={{ color: tokens.textMuted }}>{"> "}</span>
      <ComposerPrimitive.Input
        submitOnEnter
        placeholder="Ask Deus to do something…"
        autoFocus
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          resize: "none",
          color: tokens.textPrimary,
          font: "inherit",
        }}
      />
    </ComposerPrimitive.Root>
  );
};
