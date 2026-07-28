// LIA-495 — port of web-first-demo's runtime/tokens.ts (itself a port of
// the LIA-493 round-5 Ink full-shell prototype's `tokens` object) back to
// the Ink target.
//
// GENUINE MODIFICATION, not a cosmetic import-path change: web-first-demo's
// `tokens` values are CSS custom-property strings (`"var(--cc-text-muted)"`
// etc.) — real DOM colors resolved by src/index.css. Ink's `<Text color>`
// prop (chalk under the hood) has no CSS engine and cannot resolve a
// `var(...)` string at all; passing one through unchanged would silently
// fail to color anything in the terminal. So these are restored to the
// same literal hex values full-shell.tsx's own `tokens` object used
// (cc-design-spec.md § Color system) — the ORIGINAL values web-first-demo
// itself copied verbatim before re-pointing them at CSS vars for the DOM
// target. Every other export in this file (BULLET, GERUND_WORDS, sleep) is
// unchanged from web-first-demo, copied verbatim.
export const tokens = {
  textMuted: "#B0AEA5",
  textPrimary: "#FAF9F5",
  accentPrimary: "#D97757",
  accentInfo: "#6A9BCC",
  semanticSuccess: "#788C5D",
  semanticWarning: "#C49A52",
  semanticError: "#B95C50",
  borderNeutral: "#B0AEA5",
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
