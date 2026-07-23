/**
 * Adapted from google-gemini/gemini-cli's
 * packages/cli/src/ui/themes/theme-manager.ts (Apache-2.0). The active/
 * settings-theme selection mechanism (setActiveTheme/getActiveTheme,
 * getColors/getSemanticColors + terminal-background-aware interpolation,
 * findThemeByName, settings-driven custom themes via loadCustomThemes) is
 * kept 1:1. Two layers are deliberately stripped — Deus has no equivalent for
 * either:
 *
 * 1. Extension themes (`registerExtensionThemes`/`unregisterExtensionThemes`/
 *    `hasExtensionThemes`/`clearExtensionThemes`, the `extensionThemes` map).
 *    Gemini CLI has an extensions system that can ship bundled themes; Deus
 *    has no extensions system (per the plan's "Deleted, never ported" list),
 *    so this whole registration surface has no caller and was removed rather
 *    than kept as dead code.
 * 2. File themes (`loadThemeFromFile`, the `isPath` dispatch in
 *    `findThemeByName`, `clearFileThemes`, the `fileThemes` map, and the
 *    `fs`/`path`/`homedir` dependency-injection plumbing that only existed to
 *    support this — including the constructor's `dependencies` param and
 *    `reinitialize()`). This let users point at an arbitrary `~/`-relative
 *    JSON theme file on disk. Nothing in the file plan (`deus-chat-stream-
 *    bridge.ts`, the command framework's `/theme`) calls for loading a theme
 *    from an arbitrary file path — settings-driven custom themes
 *    (`loadCustomThemes`) already cover "a user-authored custom palette"
 *    without a filesystem-read surface, so this was cut rather than carried
 *    as unused surface area with a security check (home-dir containment) to
 *    maintain for no caller.
 *
 * Two smaller adaptations, both forced by removing gemini-cli-core as a
 * dependency (Deus does not import that package):
 * - `debugLogger.warn(...)` (gemini-cli-core's logger) becomes an injectable
 *   `warn` callback, defaulting to a no-op. `src/cli/tui/` has zero existing
 *   usage of this repo's pino `logger` (`src/logger.ts`) inside any
 *   TUI-subtree file — Ink owns the terminal in raw/alt-screen mode there,
 *   and an unrelated stdout-writing logger mid-render is a real corruption
 *   risk this repo's own TUI code already avoids by omission. Routing
 *   invalid-custom-theme warnings anywhere real (a status banner, etc.) is
 *   left to whichever later build-sequence step wires ThemeManager into the
 *   UI, via this injection point, rather than this step guessing at it.
 * - `CustomTheme` type comes from `../theme.js` (defined locally there, see
 *   that file's header) instead of `@google/gemini-cli-core`.
 *
 * `availableThemes` collapses from gemini's real 19-entry array (11 dark + 8
 * light builtin palettes) down to Deus's single new `builtin/deus-default.ts`
 * theme — see that file's header for the design rationale. `DEFAULT_THEME`
 * points at it. `isDefaultTheme`'s light/dark-pair check (gemini compares
 * against both `DEFAULT_THEME` and a separate `DefaultLight`) simplifies to a
 * single-name comparison since there is no separate light variant to pair
 * against.
 *
 * See LIA-473's plan build-sequence
 * step 3.
 */

import type { Theme, ThemeType, ColorsTheme, CustomTheme } from './theme.js';
import {
  createCustomTheme,
  validateCustomTheme,
  interpolateColor,
  getThemeTypeFromBackgroundColor,
  resolveColor,
} from './theme.js';
import type { SemanticColors } from './semantic-tokens.js';
import {
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_INPUT_BACKGROUND_OPACITY,
  DEFAULT_SELECTION_OPACITY,
  DEFAULT_BORDER_OPACITY,
} from './constants.js';
import { DeusDefault } from './builtin/deus-default.js';
import { NoColorTheme } from './builtin/no-color.js';
import process from 'node:process';

export interface ThemeDisplay {
  name: string;
  type: ThemeType;
  isCustom?: boolean;
}

export const DEFAULT_THEME: Theme = DeusDefault;

class ThemeManager {
  private readonly availableThemes: Theme[];
  private activeTheme: Theme;
  private settingsThemes: Map<string, Theme> = new Map();
  private terminalBackground: string | undefined;

  // Cache for dynamic colors
  private cachedColors: ColorsTheme | undefined;
  private cachedSemanticColors: SemanticColors | undefined;
  private lastCacheKey: string | undefined;

  private warn: (message: string) => void;

  constructor(dependencies?: { warn?: (message: string) => void }) {
    this.warn = dependencies?.warn ?? (() => {});

    this.availableThemes = [DeusDefault];
    this.activeTheme = DEFAULT_THEME;
  }

  setTerminalBackground(color: string | undefined): void {
    if (this.terminalBackground !== color) {
      this.terminalBackground = color;
      this.clearCache();
    }
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  private clearCache(): void {
    this.cachedColors = undefined;
    this.cachedSemanticColors = undefined;
    this.lastCacheKey = undefined;
  }

  isDefaultTheme(themeName: string | undefined): boolean {
    return themeName === undefined || themeName === DEFAULT_THEME.name;
  }

  /**
   * Loads custom themes from settings.
   * @param customThemesSettings Custom themes from settings.
   */
  loadCustomThemes(customThemesSettings?: Record<string, CustomTheme>): void {
    this.settingsThemes.clear();

    if (!customThemesSettings) {
      return;
    }

    for (const [name, customThemeConfig] of Object.entries(
      customThemesSettings,
    )) {
      const validation = validateCustomTheme(customThemeConfig);
      if (validation.isValid) {
        if (validation.warning) {
          this.warn(`Theme "${name}": ${validation.warning}`);
        }
        const themeWithDefaults: CustomTheme = {
          ...DEFAULT_THEME.colors,
          ...customThemeConfig,
          name: customThemeConfig.name || name,
          type: 'custom',
        };

        try {
          const theme = createCustomTheme(themeWithDefaults);
          this.settingsThemes.set(name, theme);
        } catch (error) {
          this.warn(`Failed to load custom theme "${name}": ${String(error)}`);
        }
      } else {
        this.warn(`Invalid custom theme "${name}": ${validation.error}`);
      }
    }
    // If the current active theme is a settings theme, keep it if still valid
    if (
      this.activeTheme &&
      this.activeTheme.type === 'custom' &&
      this.settingsThemes.has(this.activeTheme.name)
    ) {
      this.activeTheme = this.settingsThemes.get(this.activeTheme.name)!;
    }
  }

  /**
   * Resets the ThemeManager state to defaults.
   * This is for testing purposes to ensure test isolation.
   */
  resetForTesting(dependencies?: { warn?: (message: string) => void }): void {
    if (dependencies?.warn) {
      this.warn = dependencies.warn;
    }
    this.settingsThemes.clear();
    this.activeTheme = DEFAULT_THEME;
    this.terminalBackground = undefined;
    this.clearCache();
  }

  setActiveTheme(themeName: string | undefined): boolean {
    const theme = this.findThemeByName(themeName);
    if (!theme) {
      return false;
    }
    if (this.activeTheme !== theme) {
      this.activeTheme = theme;
      this.clearCache();
    }
    return true;
  }

  /**
   * Gets the currently active theme.
   * @returns The active theme.
   */
  getActiveTheme(): Theme {
    if (process.env['NO_COLOR']) {
      return NoColorTheme;
    }

    if (this.activeTheme) {
      const isBuiltIn = this.availableThemes.some(
        (t) => t.name === this.activeTheme.name,
      );
      const isCustom = [...this.settingsThemes.values()].includes(
        this.activeTheme,
      );

      if (isBuiltIn || isCustom) {
        return this.activeTheme;
      }

      // If the theme object is no longer valid, try to find it again by name.
      const reloadedTheme = this.findThemeByName(this.activeTheme.name);
      if (reloadedTheme) {
        this.activeTheme = reloadedTheme;
        return this.activeTheme;
      }
    }

    // Fallback to default if no active theme or if it's no longer valid.
    this.activeTheme = DEFAULT_THEME;
    return this.activeTheme;
  }

  /**
   * Gets the colors for the active theme, respecting the terminal background.
   * @returns The theme colors.
   */
  getColors(): ColorsTheme {
    const activeTheme = this.getActiveTheme();
    const cacheKey = `${activeTheme.name}:${this.terminalBackground}`;
    if (this.cachedColors && this.lastCacheKey === cacheKey) {
      return this.cachedColors;
    }

    const colors = activeTheme.colors;
    if (
      this.terminalBackground &&
      this.isThemeCompatible(activeTheme, this.terminalBackground)
    ) {
      this.cachedColors = {
        ...colors,
        Background: this.terminalBackground,
        DarkGray: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_BORDER_OPACITY,
        ),
        InputBackground: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_INPUT_BACKGROUND_OPACITY,
        ),
        MessageBackground: interpolateColor(
          this.terminalBackground,
          colors.Gray,
          DEFAULT_BACKGROUND_OPACITY,
        ),
        FocusBackground: interpolateColor(
          this.terminalBackground,
          activeTheme.colors.FocusColor ?? activeTheme.colors.AccentGreen,
          DEFAULT_SELECTION_OPACITY,
        ),
      };
    } else {
      this.cachedColors = colors;
    }

    this.lastCacheKey = cacheKey;
    return this.cachedColors;
  }

  /**
   * Gets the semantic colors for the active theme.
   * @returns The semantic colors.
   */
  getSemanticColors(): SemanticColors {
    const activeTheme = this.getActiveTheme();
    const cacheKey = `${activeTheme.name}:${this.terminalBackground}`;
    if (this.cachedSemanticColors && this.lastCacheKey === cacheKey) {
      return this.cachedSemanticColors;
    }

    const semanticColors = activeTheme.semanticColors;
    if (
      this.terminalBackground &&
      this.isThemeCompatible(activeTheme, this.terminalBackground)
    ) {
      const colors = this.getColors();
      this.cachedSemanticColors = {
        ...semanticColors,
        background: {
          ...semanticColors.background,
          primary: this.terminalBackground,
          message: colors.MessageBackground!,
          input: colors.InputBackground!,
          focus: colors.FocusBackground!,
        },
        border: {
          ...semanticColors.border,
          default: colors.DarkGray,
        },
        ui: {
          ...semanticColors.ui,
          dark: colors.DarkGray,
          focus: colors.FocusColor ?? colors.AccentGreen,
        },
      };
    } else {
      this.cachedSemanticColors = semanticColors;
    }

    this.lastCacheKey = cacheKey;
    return this.cachedSemanticColors;
  }

  isThemeCompatible(
    activeTheme: Theme,
    terminalBackground: string | undefined,
  ): boolean {
    if (activeTheme.type === 'ansi') {
      return true;
    }

    const backgroundType = getThemeTypeFromBackgroundColor(terminalBackground);
    if (!backgroundType) {
      return true;
    }

    const themeType =
      activeTheme.type === 'custom'
        ? getThemeTypeFromBackgroundColor(
            resolveColor(activeTheme.colors.Background) ||
              activeTheme.colors.Background,
          )
        : activeTheme.type;

    return themeType === backgroundType;
  }

  /**
   * Gets a list of custom theme names.
   * @returns Array of custom theme names.
   */
  getCustomThemeNames(): string[] {
    return Array.from(this.settingsThemes.values()).map((theme) => theme.name);
  }

  /**
   * Checks if a theme name is a custom theme.
   * @param themeName The theme name to check.
   * @returns True if the theme is custom.
   */
  isCustomTheme(themeName: string): boolean {
    return this.settingsThemes.has(themeName);
  }

  /**
   * Returns a list of available theme names.
   */
  getAvailableThemes(): ThemeDisplay[] {
    const builtInThemes = this.availableThemes.map((theme) => ({
      name: theme.name,
      type: theme.type,
      isCustom: false,
    }));

    const customThemes = Array.from(this.settingsThemes.values()).map(
      (theme) => ({
        name: theme.name,
        type: theme.type,
        isCustom: true,
      }),
    );

    const allThemes = [...builtInThemes, ...customThemes];

    const sortedThemes = allThemes.sort((a, b) => {
      const typeOrder = (type: ThemeType): number => {
        switch (type) {
          case 'dark':
            return 1;
          case 'light':
            return 2;
          case 'ansi':
            return 3;
          case 'custom':
            return 4; // Custom themes at the end
          default:
            return 5;
        }
      };

      const typeComparison = typeOrder(a.type) - typeOrder(b.type);
      if (typeComparison !== 0) {
        return typeComparison;
      }
      return a.name.localeCompare(b.name);
    });

    return sortedThemes;
  }

  /**
   * Gets a theme by name.
   * @param themeName The name of the theme to get.
   * @returns The theme if found, undefined otherwise.
   */
  getTheme(themeName: string): Theme | undefined {
    return this.findThemeByName(themeName);
  }

  /**
   * Gets all available themes.
   * @returns A list of all available themes.
   */
  getAllThemes(): Theme[] {
    return [
      ...this.availableThemes,
      ...Array.from(this.settingsThemes.values()),
    ];
  }

  findThemeByName(themeName: string | undefined): Theme | undefined {
    if (!themeName) {
      return DEFAULT_THEME;
    }

    // First check built-in themes
    const builtInTheme = this.availableThemes.find(
      (theme) => theme.name === themeName,
    );
    if (builtInTheme) {
      return builtInTheme;
    }

    // Then check custom themes loaded from settings
    if (this.settingsThemes.has(themeName)) {
      return this.settingsThemes.get(themeName);
    }

    // If it's not a built-in and not a settings theme, it's not a valid theme.
    return undefined;
  }
}

// Export an instance of the ThemeManager
export const themeManager = new ThemeManager();
