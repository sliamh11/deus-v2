/**
 * Ported 1:1, verbatim, from google-gemini/gemini-cli's
 * packages/cli/src/ui/themes/builtin/no-color.ts (Apache-2.0). Kept
 * deliberately (not deleted with the other 19 builtin/dark+light palette
 * files): this is a real accessibility feature — theme-manager.ts's
 * getActiveTheme() returns it whenever the user's environment sets NO_COLOR
 * (https://no-color.org/), an env-var convention, not an aesthetic palette
 * choice. Deleting it would silently drop NO_COLOR support rather than
 * "not port a builtin palette."
 *
 * See /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md build-sequence
 * step 3.
 */

import { Theme, type ColorsTheme } from '../theme.js';
import type { SemanticColors } from '../semantic-tokens.js';

const noColorColorsTheme: ColorsTheme = {
  type: 'ansi',
  Background: '',
  Foreground: '',
  LightBlue: '',
  AccentBlue: '',
  AccentPurple: '',
  AccentCyan: '',
  AccentGreen: '',
  AccentYellow: '',
  AccentRed: '',
  DiffAdded: '',
  DiffRemoved: '',
  Comment: '',
  Gray: '',
  DarkGray: '',
  InputBackground: '',
  MessageBackground: '',
  FocusBackground: '',
};

const noColorSemanticColors: SemanticColors = {
  text: {
    primary: '',
    secondary: '',
    link: '',
    accent: '',
    response: '',
  },
  background: {
    primary: '',
    message: '',
    input: '',
    focus: '',
    diff: {
      added: '',
      removed: '',
    },
  },
  border: {
    default: '',
  },
  ui: {
    comment: '',
    symbol: '',
    active: '',
    dark: '',
    focus: '',
    gradient: [],
  },
  status: {
    error: '',
    success: '',
    warning: '',
  },
};

export const NoColorTheme: Theme = new Theme(
  'NoColor',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
    },
    'hljs-keyword': {},
    'hljs-literal': {},
    'hljs-symbol': {},
    'hljs-name': {},
    'hljs-link': {
      textDecoration: 'underline',
    },
    'hljs-built_in': {},
    'hljs-type': {},
    'hljs-number': {},
    'hljs-class': {},
    'hljs-string': {},
    'hljs-meta-string': {},
    'hljs-regexp': {},
    'hljs-template-tag': {},
    'hljs-subst': {},
    'hljs-function': {},
    'hljs-title': {},
    'hljs-params': {},
    'hljs-formula': {},
    'hljs-comment': {
      fontStyle: 'italic',
    },
    'hljs-quote': {
      fontStyle: 'italic',
    },
    'hljs-doctag': {},
    'hljs-meta': {},
    'hljs-meta-keyword': {},
    'hljs-tag': {},
    'hljs-variable': {},
    'hljs-template-variable': {},
    'hljs-attr': {},
    'hljs-attribute': {},
    'hljs-builtin-name': {},
    'hljs-section': {},
    'hljs-emphasis': {
      fontStyle: 'italic',
    },
    'hljs-strong': {
      fontWeight: 'bold',
    },
    'hljs-bullet': {},
    'hljs-selector-tag': {},
    'hljs-selector-id': {},
    'hljs-selector-class': {},
    'hljs-selector-attr': {},
    'hljs-selector-pseudo': {},
    'hljs-addition': {
      display: 'inline-block',
      width: '100%',
    },
    'hljs-deletion': {
      display: 'inline-block',
      width: '100%',
    },
  },
  noColorColorsTheme,
  noColorSemanticColors,
);
