// LIA-495 — DOM equivalent of full-shell.tsx's Header/useShellStatus.
// Same status derivation (runtime/hooks.ts's useShellStatus, ported
// verbatim), same three-state color mapping — an Ink `<Box borderBottom>`
// becomes a `<div>` with a CSS bottom border.
import type { FC } from "react";
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
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 4,
        borderBottom: `1px solid ${tokens.borderNeutral}`,
        paddingBottom: 8,
        marginBottom: 16,
      }}
    >
      <span style={{ fontWeight: 700, color: tokens.textPrimary }}>deus-v2-mvp</span>
      <span style={{ color: tokens.textMuted }}>· full-shell-demo (LIA-495) ·</span>
      <span style={{ color }}>
        {BULLET} {label}
      </span>
    </div>
  );
};
