/**
 * Assembles every real `tui-v2` command body into one registry-ready list.
 * `/help` is built last since it needs to describe every other command (see
 * `helpCommand.ts`'s header) — it is not self-referential (it doesn't list
 * itself), matching Gemini's real `helpCommand`, which also doesn't
 * self-describe.
 */

import { planCommand } from './planCommand.js';
import { statusCommand } from './statusCommand.js';
import { exitCommand } from './exitCommand.js';
import { themeCommand } from './themeCommand.js';
import { clearCommand } from './clearCommand.js';
import { copyCommand } from './copyCommand.js';
import { createHelpCommand } from './helpCommand.js';
import type { SlashCommand } from './types.js';

const COMMANDS_WITHOUT_HELP: readonly SlashCommand[] = [
  planCommand,
  statusCommand,
  exitCommand,
  themeCommand,
  clearCommand,
  copyCommand,
];

export const ALL_COMMANDS: readonly SlashCommand[] = [
  ...COMMANDS_WITHOUT_HELP,
  createHelpCommand(COMMANDS_WITHOUT_HELP),
];

export * from './types.js';
export * from './registry.js';
