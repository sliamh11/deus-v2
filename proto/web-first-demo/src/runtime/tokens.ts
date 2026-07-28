// LIA-495 — web port of the LIA-493 round-5 Ink full-shell prototype
// (proto/assistant-ui-demo/src/full-shell.tsx in the sibling
// proto-lia493-assistant-ui-ink worktree). This file mirrors that fixture's
// non-DOM constants verbatim.
//
// Design-token VALUES are copied verbatim from full-shell.tsx's `tokens`
// object (cc-design-spec.md § Color system), which itself copied them from
// permission-screen.tsx/diff-screen.tsx. The CSS custom properties in
// src/index.css are the single source of truth for how these render (so
// dark/light and any future re-theming stays in CSS, not scattered inline
// styles) — this object exists only so non-style TS/TSX logic (e.g. picking
// a status color by name) can reference the SAME token names the ink
// version used, without re-deriving them from CSS at runtime.
export const tokens = {
  textMuted: "var(--cc-text-muted)",
  textPrimary: "var(--cc-text-primary)",
  accentPrimary: "var(--cc-accent-primary)",
  accentInfo: "var(--cc-accent-info)",
  semanticSuccess: "var(--cc-semantic-success)",
  semanticWarning: "var(--cc-semantic-warning)",
  semanticError: "var(--cc-semantic-error)",
  borderNeutral: "var(--cc-border-neutral)",
} as const;

// The single stateful glyph — never swapped for a checkmark/X glyph family.
// Identical rule and identical character to full-shell.tsx's BULLET.
export const BULLET = "⏺";

// Rotating-gerund spinner word list (spec § Spinner and active status).
// Copied verbatim from full-shell.tsx's GERUND_WORDS — same words, same
// order, so the web and ink demos read identically while "thinking".
export const GERUND_WORDS = [
  "Pondering",
  "Percolating",
  "Cogitating",
  "Ruminating",
  "Deliberating",
  "Musing",
  "Inferring",
  "Deciphering",
] as const;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
