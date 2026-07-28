// LIA-496 — shiki singleton highlighter, target-neutral grammar/engine
// only. Corrected during plan-review: shiki has no `codeToAnsi` API at any
// version up to 4.3.1 (confirmed by grepping the installed dist for "ansi"
// — zero matches); the real mechanism is `codeToTokens()`'s per-token
// resolved hex `color` field. Web renders that (or `codeToHtml`'s string)
// directly; Ink walks `codeToTokens()`'s output token-by-token in its own
// `TokenLine.tsx`, wrapping each token in `<Text color={token.color}>` —
// same grammar/tokenizer/theme resolution, two renderers, each living in
// its own target.
//
// Purity: this module owns the LANGUAGE list only. Theme SELECTION is
// per-target presentation — `highlightToHtml`/`highlightToTokens` below
// take `theme` as a caller-supplied parameter; no theme name is a constant
// in this file's own logic. The one place theme names appear below is the
// pre-warm block, which is a deliberate, explicitly-scoped exception (see
// its own comment) — check-shared-purity.sh's pattern set does not include
// a "theme name" grep (theme names aren't hex/CSS/ANSI literals), so this
// doesn't trip the gate; it's called out here so a future purity-gate edit
// doesn't "fix" it into a false positive, matching the note SETUP-NOTES.md
// §10 makes about the `@assistant-ui/core/react` subpath.
import {
  getSingletonHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
} from "shiki";

// The language grammars this spike's fixture content actually uses:
// TypeScript/TSX source in Edit-tool diffs, shell commands in Bash-tool
// calls, unified diff format for the diff-panel content, JSON for tool
// args, and Markdown for assistant prose containing fenced code blocks.
const LANGS: BundledLanguage[] = ["typescript", "tsx", "bash", "diff", "json", "markdown"];

// ---------------------------------------------------------------------------
// Pre-warm (S1, per the plan's round-4 refinement): a top-level `await` in
// THIS module means the warmth guarantee is part of the module's own
// import-time contract — `web-app` and `ink-app`'s S2A/S2B builds cannot
// forget it or implement it inconsistently, because it isn't something
// either app has to remember to do; it already happened by the time either
// app's first component evaluates.
//
// Both target theme names are named here, once, for the sole purpose of
// pre-loading them into the shared singleton before either app renders a
// single frame. Reasoned choices (S1; open to S2A/S2B confirming/
// swapping — see this module's header comment on why this doesn't trip the
// purity gate). Exact swatch values live only in design-source/
// taste-pass-fable.html and each target's own theme file, never repeated
// here:
//   - "github-dark-default": Reading Room's inset code card sits dark
//     against the page's warm-light ground per the design source — a
//     clean, high-legibility dark theme for a card, not a full-page
//     terminal.
//   - "vesper": Transcript is described in the design source as a warm,
//     phosphor-toned dark terminal look — vesper is the closest built-in
//     match among shiki's bundled set to that warm-toned family without
//     hand-authoring a custom TextMate theme for this spike.
const WEB_PREWARM_THEME = "github-dark-default";
const INK_PREWARM_THEME = "vesper";

const highlighter: Highlighter = await getSingletonHighlighter({ langs: LANGS });
await Promise.all([
  highlighter.loadTheme(WEB_PREWARM_THEME),
  highlighter.loadTheme(INK_PREWARM_THEME),
]);

// ---------------------------------------------------------------------------
// Thin wrappers around the highlighter INSTANCE methods (synchronous once
// warm — not the async `codeToHtml`/`codeToTokens` top-level shorthand
// functions, which re-resolve a singleton and their language/theme on
// every call). `theme` is supplied by the caller; this module never picks
// one on its own behalf.
// ---------------------------------------------------------------------------
export function highlightToHtml(
  code: string,
  lang: BundledLanguage,
  theme: BundledTheme,
): string {
  return highlighter.codeToHtml(code, { lang, theme });
}

export function highlightToTokens(code: string, lang: BundledLanguage, theme: BundledTheme) {
  return highlighter.codeToTokens(code, { lang, theme });
}

// Exposed so a target can load a theme it wasn't pre-warmed with (e.g. a
// user-selectable theme picker, out of scope for this spike but not worth
// closing off) without reaching into the module-private singleton.
export async function ensureThemeLoaded(theme: BundledTheme): Promise<void> {
  await highlighter.loadTheme(theme);
}

export async function ensureLanguageLoaded(lang: BundledLanguage): Promise<void> {
  await highlighter.loadLanguage(lang);
}
