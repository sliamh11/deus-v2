/**
 * Basic unit tests for the adapted theme-manager.ts (build-sequence step 3,
 * see /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md). Covers what
 * survived the port unchanged (active-theme selection, terminal-background
 * interpolation, settings-driven custom themes, NO_COLOR) — not a re-port of
 * gemini-cli's own theme-manager.test.ts, which also covered the
 * extension-theme and file-theme layers this file deliberately strips (see
 * theme-manager.ts's header comment).
 */

// Unset NO_COLOR at the very top before any imports, same guard gemini-cli's
// own theme-manager.test.ts uses — a NO_COLOR-polluted CI/dev environment
// would otherwise make getActiveTheme() always return NoColorTheme.
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  themeManager,
  DEFAULT_THEME,
  type ThemeDisplay,
} from './theme-manager.js';
import type { CustomTheme } from './theme.js';
import { DeusDefault } from './builtin/deus-default.js';
import { NoColorTheme } from './builtin/no-color.js';

const validCustomTheme: CustomTheme = {
  name: 'My Custom Theme',
  text: { primary: '#ffffff' },
  background: { primary: '#000000' },
};

describe('themeManager', () => {
  beforeEach(() => {
    themeManager.resetForTesting();
  });

  afterEach(() => {
    delete process.env['NO_COLOR'];
  });

  it('defaults to DeusDefault as both DEFAULT_THEME and the active theme', () => {
    expect(DEFAULT_THEME).toBe(DeusDefault);
    expect(themeManager.getActiveTheme()).toBe(DeusDefault);
  });

  it('lists exactly one built-in theme', () => {
    const themes: ThemeDisplay[] = themeManager.getAvailableThemes();
    expect(themes).toEqual([
      { name: 'Deus Default', type: 'dark', isCustom: false },
    ]);
  });

  it('setActiveTheme switches to a known theme and rejects an unknown one', () => {
    expect(themeManager.setActiveTheme('Deus Default')).toBe(true);
    expect(themeManager.setActiveTheme('Nonexistent Theme')).toBe(false);
    // Active theme is unchanged after the rejected switch.
    expect(themeManager.getActiveTheme().name).toBe('Deus Default');
  });

  it('respects NO_COLOR by returning NoColorTheme regardless of the active theme', () => {
    themeManager.setActiveTheme('Deus Default');
    process.env['NO_COLOR'] = '1';
    expect(themeManager.getActiveTheme()).toBe(NoColorTheme);
  });

  it('loads a settings-driven custom theme and can select it', () => {
    // settingsThemes is keyed by the settings-map key, not the theme's own
    // `.name` field (ported unchanged from the donor) — realistic settings
    // usage keys a custom theme by its own name, as here.
    themeManager.loadCustomThemes({ 'My Custom Theme': validCustomTheme });
    expect(themeManager.isCustomTheme('My Custom Theme')).toBe(true);
    expect(themeManager.getCustomThemeNames()).toEqual(['My Custom Theme']);

    expect(themeManager.setActiveTheme('My Custom Theme')).toBe(true);
    expect(themeManager.getActiveTheme().colors.Foreground).toBe('#ffffff');
  });

  it('clears previously loaded custom themes on a fresh loadCustomThemes call', () => {
    themeManager.loadCustomThemes({ 'My Custom Theme': validCustomTheme });
    expect(themeManager.isCustomTheme('My Custom Theme')).toBe(true);

    themeManager.loadCustomThemes({});
    expect(themeManager.isCustomTheme('My Custom Theme')).toBe(false);
  });

  it('rejects a custom theme with an invalid (too-long) name and reports it via the warn hook', () => {
    const warnings: string[] = [];
    themeManager.resetForTesting({ warn: (message) => warnings.push(message) });

    themeManager.loadCustomThemes({ bad: { name: 'a'.repeat(51) } });
    expect(themeManager.isCustomTheme('bad')).toBe(false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Invalid custom theme/);
  });

  it('recomputes DarkGray/InputBackground/MessageBackground/FocusBackground from a compatible terminal background', () => {
    themeManager.setTerminalBackground('#0b0e14'); // matches DeusDefault's own dark Background
    const colors = themeManager.getColors();
    expect(colors.Background).toBe('#0b0e14');
    expect(colors.DarkGray).not.toBe(DeusDefault.colors.DarkGray);
  });

  it('leaves colors untouched when the terminal background type mismatches the active theme', () => {
    themeManager.setTerminalBackground('#ffffff'); // light bg against DeusDefault's dark type
    const colors = themeManager.getColors();
    expect(colors).toEqual(DeusDefault.colors);
  });

  it('caches getColors()/getSemanticColors() until the active theme or terminal background changes', () => {
    const first = themeManager.getColors();
    const second = themeManager.getColors();
    expect(second).toBe(first); // same object reference: cache hit

    themeManager.setTerminalBackground('#111111');
    const third = themeManager.getColors();
    expect(third).not.toBe(first); // cache invalidated by the background change
  });

  it('findThemeByName falls back to DEFAULT_THEME for an empty name and undefined for an unknown one', () => {
    expect(themeManager.findThemeByName(undefined)).toBe(DEFAULT_THEME);
    expect(themeManager.findThemeByName('Totally Unknown')).toBeUndefined();
  });
});
