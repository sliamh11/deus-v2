/**
 * Basic unit tests for the ported theme.ts (build-sequence step 3, see
 * LIA-473's plan). Not a re-port of
 * gemini-cli's own theme.test.ts — a focused check that the color-resolution
 * primitives (unchanged donor logic) still behave post-port, and that
 * Theme/createCustomTheme (whose CustomTheme type is now locally defined
 * instead of imported from @google/gemini-cli-core) still build correctly.
 */

import { describe, expect, it } from 'vitest';

import {
  Theme,
  createCustomTheme,
  darkTheme,
  getLuminance,
  getThemeTypeFromBackgroundColor,
  interpolateColor,
  lightTheme,
  pickDefaultThemeName,
  resolveColor,
  validateCustomTheme,
} from './theme.js';
import { DeusDefault } from './builtin/deus-default.js';

describe('resolveColor', () => {
  it('passes through a valid 6-digit hex code', () => {
    expect(resolveColor('#5FA8FF')).toBe('#5fa8ff');
  });

  it('normalizes a bare (no #) hex code', () => {
    expect(resolveColor('5fa8ff')).toBe('#5fa8ff');
  });

  it('passes through an Ink-supported named color', () => {
    expect(resolveColor('cyan')).toBe('cyan');
  });

  it('resolves a known CSS color name to hex', () => {
    expect(resolveColor('rebeccapurple')).toBe('#663399');
  });

  it('returns undefined for an unresolvable value', () => {
    expect(resolveColor('not-a-real-color')).toBeUndefined();
  });

  it('rejects a malformed hex code', () => {
    expect(resolveColor('#zzz')).toBeUndefined();
  });
});

describe('getLuminance / getThemeTypeFromBackgroundColor', () => {
  it('rates black as dark and white as light', () => {
    expect(getLuminance('#000000')).toBeLessThan(getLuminance('#ffffff'));
    expect(getThemeTypeFromBackgroundColor('#000000')).toBe('dark');
    expect(getThemeTypeFromBackgroundColor('#ffffff')).toBe('light');
  });

  it('returns undefined for an empty background', () => {
    expect(getThemeTypeFromBackgroundColor(undefined)).toBeUndefined();
  });
});

describe('interpolateColor', () => {
  it('returns color1 at factor 0 and color2 at factor 1', () => {
    expect(interpolateColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(interpolateColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('returns a color partway between the two endpoints for a mid factor', () => {
    const mid = interpolateColor('#000000', '#ffffff', 0.5);
    expect(mid).not.toBe('#000000');
    expect(mid).not.toBe('#ffffff');
    expect(mid).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('Theme', () => {
  it('derives semanticColors from ColorsTheme when none are passed explicitly', () => {
    const theme = new Theme('Test', 'dark', {}, darkTheme);
    expect(theme.semanticColors.text.primary).toBe(darkTheme.Foreground);
    expect(theme.semanticColors.status.error).toBe(darkTheme.AccentRed);
  });

  it('builds an Ink-compatible color map from raw hljs mappings, skipping unresolvable colors', () => {
    const theme = new Theme(
      'Test',
      'light',
      {
        hljs: { color: lightTheme.Foreground },
        'hljs-keyword': { color: '#5F00FF' },
        'hljs-broken': { color: 'not-a-real-color' },
        'not-hljs-prefixed': { color: '#ffffff' },
      },
      lightTheme,
    );
    expect(theme.getInkColor('hljs-keyword')).toBe('#5f00ff');
    expect(theme.getInkColor('hljs-broken')).toBeUndefined();
    expect(theme.getInkColor('not-hljs-prefixed')).toBeUndefined();
  });
});

describe('createCustomTheme / validateCustomTheme', () => {
  it('builds a usable Theme from a minimal nested custom-theme config', () => {
    const theme = createCustomTheme({
      name: 'My Custom Theme',
      text: { primary: '#eeeeee' },
      background: { primary: '#111111' },
      status: { error: '#ff0000' },
    });
    expect(theme.name).toBe('My Custom Theme');
    expect(theme.type).toBe('custom');
    expect(theme.colors.Foreground).toBe('#eeeeee');
    expect(theme.colors.Background).toBe('#111111');
    expect(theme.semanticColors.status.error).toBe('#ff0000');
  });

  it('accepts legacy flat ColorsTheme-shaped fields as a fallback', () => {
    const theme = createCustomTheme({
      name: 'Legacy Shape',
      Foreground: '#dddddd',
      Background: '#0f0f0f',
    });
    expect(theme.colors.Foreground).toBe('#dddddd');
    expect(theme.colors.Background).toBe('#0f0f0f');
  });

  it('rejects a too-long theme name', () => {
    expect(validateCustomTheme({ name: 'a'.repeat(51) }).isValid).toBe(false);
  });

  it('treats a falsy (empty) name as "no name given" rather than invalid', () => {
    // Ported unchanged from the donor: `if (customTheme.name && ...)` short-
    // circuits on an empty string, so validation passes it through — the
    // caller (loadCustomThemes) falls back to the settings-map key for the
    // actual theme name in that case, it never reaches createCustomTheme
    // with a blank name.
    expect(validateCustomTheme({ name: '' }).isValid).toBe(true);
  });

  it('accepts a valid theme name', () => {
    expect(validateCustomTheme({ name: 'Fine' }).isValid).toBe(true);
    expect(validateCustomTheme({}).isValid).toBe(true);
  });
});

describe('pickDefaultThemeName', () => {
  it('matches an available theme whose background equals the terminal background', () => {
    const name = pickDefaultThemeName(
      DeusDefault.colors.Background,
      [DeusDefault],
      'Deus Default',
      'Deus Default',
    );
    expect(name).toBe('Deus Default');
  });

  it('falls back to the light/dark default by luminance when nothing matches exactly', () => {
    expect(
      pickDefaultThemeName('#ffffff', [], 'DarkDefault', 'LightDefault'),
    ).toBe('LightDefault');
    expect(
      pickDefaultThemeName('#000000', [], 'DarkDefault', 'LightDefault'),
    ).toBe('DarkDefault');
  });
});
