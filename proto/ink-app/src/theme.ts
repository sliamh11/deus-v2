// LIA-496 — "Transcript" (Ink target)'s own presentation values. Literal
// hex, not CSS custom properties: chalk/Ink `color` props resolve to raw
// ANSI, and there is no browser-style `var(--x)` indirection in a
// terminal — see shared/src/status.ts's header comment on why that
// indirection has to live per-target instead. Sourced directly from
// design-source/taste-pass-fable.html's `.v1 .app` block (the "Transcript"
// tab), and kept to exactly the 8 tokens named in this stage's own
// dispatch — the design source's `--c-faint` is deliberately NOT added as
// a 9th token; `dim`/`line` below stand in for it (see STATUS_COLOR and the
// components that use borders/muted labels).
export const theme = {
  bg: "#131110",
  side: "#181513",
  ink: "#E3DCD1",
  dim: "#8A8177",
  line: "#2B2723",
  amber: "#C9944A",
  ok: "#7FB069",
  err: "#C4655A",
} as const;

// shared/src/status.ts's `StatusKey` -> this target's own color. This
// mapping must never live in shared/ itself (the "tokens.ts lesson" —
// see that module's header comment); each target owns exactly one of
// these.
export const STATUS_COLOR: Record<import("@lia496/shared").StatusKey, string> = {
  accent: theme.amber,
  ok: theme.ok,
  warn: theme.amber,
  err: theme.err,
  dim: theme.dim,
};

// Gutter glyphs, per speaker — design source's `.c-g` (user, amber) /
// `.c-g.ast` (assistant, dim).
export const GLYPH_USER = "❯";
export const GLYPH_ASSISTANT = "●";

// Composer prompt glyph. This stage's dispatch is explicit: `"> "` composer
// prompt — which differs from the design source's literal markup
// (`<span class="prompt">❯</span>` inside `.c-composer`, the SAME glyph as
// the user gutter). Following the dispatch's explicit instruction as
// authoritative here (documented, not an oversight): it also matches
// LIA-495's own proven `ComposerRow` convention (`"> "`, not the gutter
// glyph) for the same terminal-prompt idiom, so Transcript's composer reads
// consistently with the rest of this codebase's Ink work, not just this
// one design mockup.
export const COMPOSER_PROMPT = "> ";

// shiki theme name for this target's TokenLine.tsx. Literal, and lives
// here — never in shared/src/highlight.ts, which only pre-warms it under
// the name `INK_PREWARM_THEME` (see that module's own purity comment on
// why theme names are per-target presentation, not shared logic).
export const CODE_THEME = "vesper" as const;
