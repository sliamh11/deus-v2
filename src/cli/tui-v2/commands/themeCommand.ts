/**
 * `/theme` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/themeCommand.ts` (Apache-2.0, fetched and
 * read directly — 22 lines). The real `themeCommand` is a one-liner that
 * always returns `{ type: 'dialog', dialog: 'theme' }`, handing off entirely
 * to a separate interactive `ThemeDialog` component (arrow-key list picker
 * over Gemini's real 19 built-in themes) that this framework has no
 * `dialog` action-return variant or dialog-manager to open (see `types.ts`'s
 * header — `OpenDialogActionReturn` wasn't ported; no Deus caller exists for
 * it yet).
 *
 * `themes/theme-manager.ts`'s header already explains why: today `tui-v2`
 * has exactly one built-in theme (`deus-default.ts`) plus whatever custom
 * themes `loadCustomThemes` loaded from settings — an interactive picker
 * over a 1-built-in-theme list has little to pick between yet. So this
 * command is "wired to the theme system from the foundation phase" (per this
 * step's brief) the direct way instead: no args lists every theme
 * `themeManager.getAvailableThemes()` knows about with the active one
 * marked, `/theme <name>` calls `setActiveTheme(name)` directly. Once a real
 * multi-theme picker UI exists, replacing this command's body is a
 * self-contained change — nothing else in the framework depends on its
 * current shape.
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

async function themeAction(
  context: SlashCommandContext,
  args: string,
): Promise<void> {
  const requested = args.trim();
  const { themeManager } = context.services;

  if (requested === '') {
    const active = themeManager.getActiveTheme().name;
    const lines = themeManager
      .getAvailableThemes()
      .map((t) => `${t.name === active ? '* ' : '  '}${t.name}`);
    context.ui.info(
      `Available themes (use /theme <name> to switch):\n${lines.join('\n')}`,
    );
    return;
  }

  const applied = themeManager.setActiveTheme(requested);
  if (!applied) {
    const names = themeManager
      .getAvailableThemes()
      .map((t) => t.name)
      .join(', ');
    context.ui.error(`Unknown theme "${requested}". Available: ${names}`);
    return;
  }
  context.ui.info(`Switched to theme "${requested}".`);
}

export const themeCommand: SlashCommand = {
  name: 'theme',
  description: 'List or switch the color theme (/theme [name])',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: themeAction,
};
