/**
 * Theme-scoped constants ported from gemini-cli's packages/cli/src/ui/constants.ts.
 *
 * Deus only needs the four opacity constants theme.ts/theme-manager.ts consume for
 * background interpolation (input/message/focus surfaces, custom-theme derived
 * DarkGray/InputBackground/etc.). The donor file bundles these alongside ~30
 * unrelated UI constants (shell output limits, tool status glyphs, subagent line
 * caps, keyboard-shortcuts URL, ...) that belong to components outside this port's
 * scope (see build-sequence step 3 vs later steps in
 * /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md). Scoping this file to
 * just the theme system avoids either porting a big irrelevant file wholesale or
 * inlining magic numbers into theme.ts/theme-manager.ts.
 */

export const DEFAULT_BACKGROUND_OPACITY = 0.16;
export const DEFAULT_INPUT_BACKGROUND_OPACITY = 0.24;
export const DEFAULT_SELECTION_OPACITY = 0.2;
export const DEFAULT_BORDER_OPACITY = 0.4;
