/**
 * Deus's own default theme — new, not a port. Written per build-sequence
 * step 3's explicit creative license
 * (/Users/liam10play/.claude/plans/deus-tui-gemini-fork.md: "a reasonable,
 * professional-looking default palette is your creative call ... go wild, be
 * creative, just keep it coherent and readable in both light and dark
 * terminal backgrounds") to replace all 19 of gemini-cli's deleted
 * builtin/dark + builtin/light palette files (ansi/atom-one/ayu/default/
 * dracula/github(-colorblind)/googlecode/holiday/shades-of-purple/solarized/
 * tokyonight/xcode, ×2 variants each minus a couple singles — see this
 * file's sibling PR report for the exact count-vs-plan discrepancy).
 *
 * Structurally this follows gemini-cli's own
 * packages/cli/src/ui/themes/builtin/dark/default-dark.ts 1:1 (same
 * `new Theme(name, type, hljsMapping, colorsTheme)` 4-arg shape, letting the
 * Theme constructor auto-derive semanticColors — no hand-written
 * SemanticColors needed here, same as the donor's DefaultDark).
 *
 * Design: a dark-first palette (matches the donor's own default and every
 * other professional agentic-CLI default this repo forks alongside —
 * Claude Code, Codex). "Readable in both light and dark terminal
 * backgrounds" is interpreted two ways, both addressed:
 *   1. Ink only paints Background/InputBackground/MessageBackground/
 *      FocusBackground on explicitly filled Boxes (input line, message
 *      surfaces, focus highlight) — the rest of the canvas is the user's own
 *      terminal background, whatever that is. So bare text drawn without a
 *      filled Box (most accent/status colors) must hold up against an
 *      *unknown* backdrop, not just this theme's own Background. Every
 *      accent below sits at a mid-to-high HSL lightness (roughly 65-80%)
 *      with real saturation — legible against both a near-black and a
 *      moderately light terminal, unlike either a near-white or a
 *      low-lightness/desaturated color would be.
 *   2. theme-manager.ts's existing getColors()/getSemanticColors()
 *      background-interpolation path (kept from the donor, see
 *      theme-manager.ts) already re-derives DarkGray/InputBackground/
 *      MessageBackground/FocusBackground against the terminal's *actual*
 *      detected background color (via OSC 11) when the theme type matches —
 *      that adaptive mechanism, not a second palette, is what the port is
 *      relying on for genuine background-color agnosticism.
 *
 * Palette identity: a blue -> violet -> pink gradient (AccentBlue/
 * AccentPurple + GradientColors) as Deus's visual signature, echoing the
 * donor's own gradient slot (['#4796E4','#847ACE','#C3677F']) but with
 * Deus's own hues. Background is a near-black with a faint indigo tint
 * (#0B0E14, not pure #000000) and Foreground a soft off-white with the same
 * tint (#E6E6F0, not pure #FFFFFF) — avoids the harsh pure-black/pure-white
 * clash professional dark themes (GitHub Dark, Tokyo Night, One Dark) all
 * avoid for the same reason.
 *
 * See /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md build-sequence
 * step 3.
 */

import { Theme, type ColorsTheme } from '../theme.js';

export const deusDefaultColors: ColorsTheme = {
  type: 'dark',
  Background: '#0B0E14',
  Foreground: '#E6E6F0',
  LightBlue: '#7FB4FF',
  AccentBlue: '#5FA8FF',
  AccentPurple: '#B58CFF',
  AccentCyan: '#67D8D2',
  AccentGreen: '#7EE787',
  AccentYellow: '#E3C567',
  AccentRed: '#FF6E6E',
  DiffAdded: '#1F4D2B',
  DiffRemoved: '#4D1F27',
  Comment: '#8A8FA3',
  Gray: '#8A8FA3',
  DarkGray: '#4A4E63',
  InputBackground: '#171B26',
  MessageBackground: '#11141C',
  FocusBackground: '#22304A',
  FocusColor: '#5FA8FF',
  GradientColors: ['#5FA8FF', '#B58CFF', '#FF8CC8'],
};

export const DeusDefault: Theme = new Theme(
  'Deus Default',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: deusDefaultColors.Background,
      color: deusDefaultColors.Foreground,
    },
    'hljs-keyword': {
      color: deusDefaultColors.AccentBlue,
    },
    'hljs-literal': {
      color: deusDefaultColors.AccentBlue,
    },
    'hljs-symbol': {
      color: deusDefaultColors.AccentBlue,
    },
    'hljs-name': {
      color: deusDefaultColors.AccentBlue,
    },
    'hljs-link': {
      color: deusDefaultColors.AccentBlue,
      textDecoration: 'underline',
    },
    'hljs-built_in': {
      color: deusDefaultColors.AccentCyan,
    },
    'hljs-type': {
      color: deusDefaultColors.AccentCyan,
    },
    'hljs-number': {
      color: deusDefaultColors.AccentGreen,
    },
    'hljs-class': {
      color: deusDefaultColors.AccentGreen,
    },
    'hljs-string': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-meta-string': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-regexp': {
      color: deusDefaultColors.AccentRed,
    },
    'hljs-template-tag': {
      color: deusDefaultColors.AccentRed,
    },
    'hljs-subst': {
      color: deusDefaultColors.Foreground,
    },
    'hljs-function': {
      color: deusDefaultColors.Foreground,
    },
    'hljs-title': {
      color: deusDefaultColors.Foreground,
    },
    'hljs-params': {
      color: deusDefaultColors.Foreground,
    },
    'hljs-formula': {
      color: deusDefaultColors.Foreground,
    },
    'hljs-comment': {
      color: deusDefaultColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-quote': {
      color: deusDefaultColors.Comment,
      fontStyle: 'italic',
    },
    'hljs-doctag': {
      color: deusDefaultColors.Comment,
    },
    'hljs-meta': {
      color: deusDefaultColors.Gray,
    },
    'hljs-meta-keyword': {
      color: deusDefaultColors.Gray,
    },
    'hljs-tag': {
      color: deusDefaultColors.Gray,
    },
    'hljs-variable': {
      color: deusDefaultColors.AccentPurple,
    },
    'hljs-template-variable': {
      color: deusDefaultColors.AccentPurple,
    },
    'hljs-attr': {
      color: deusDefaultColors.LightBlue,
    },
    'hljs-attribute': {
      color: deusDefaultColors.LightBlue,
    },
    'hljs-builtin-name': {
      color: deusDefaultColors.LightBlue,
    },
    'hljs-section': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-bullet': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-selector-tag': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-selector-id': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-selector-class': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-selector-attr': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-selector-pseudo': {
      color: deusDefaultColors.AccentYellow,
    },
    'hljs-addition': {
      backgroundColor: deusDefaultColors.DiffAdded,
      display: 'inline-block',
      width: '100%',
    },
    'hljs-deletion': {
      backgroundColor: deusDefaultColors.DiffRemoved,
      display: 'inline-block',
      width: '100%',
    },
  },
  deusDefaultColors,
);
