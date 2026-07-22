/**
 * `/help` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/helpCommand.ts` (Apache-2.0, fetched and
 * read directly — 46 lines). The real `helpCommand` special-cases
 * "antigravity install/migrate" args (an unrelated companion-CLI install
 * hint, no Deus equivalent, dropped) and otherwise appends a `MessageType.HELP`
 * history item that a separate `<Help>` dialog component renders (the full
 * command list + keybindings live in that component, not in this file).
 *
 * `tui-v2` has no separate `<Help>` dialog component yet, so this command
 * builds the same information directly as one info line: every registered
 * command (name, alt names, description) plus the v1-Rust-TUI-inspired
 * keybindings this build-sequence step adds (Ctrl+F transcript search,
 * Ctrl+R reverse-history search, `@path` file mentions) — mirroring how
 * `~/deus/tui/src/app.rs`'s own `/help` (line 1296) lists commands AND
 * keyboard shortcuts together in one block, the closest real design
 * reference for what a terminal-native `/help` should contain here.
 *
 * A factory, not a plain object: it needs the full command list to describe,
 * which only exists once every other command is defined — see `index.ts`.
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

const KEYBINDINGS = [
  'Ctrl+F  Search the transcript',
  'Ctrl+R  Reverse-search your input history',
  '@path   Reference a file — its content is inlined into your prompt',
];

function formatCommand(command: SlashCommand): string {
  const names = [command.name, ...(command.altNames ?? [])]
    .map((n) => `/${n}`)
    .join(', ');
  return `  ${names} — ${command.description}`;
}

export function createHelpCommand(
  commands: readonly SlashCommand[],
): SlashCommand {
  return {
    name: 'help',
    description: 'Show available commands and keybindings',
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: (context: SlashCommandContext) => {
      const commandLines = commands.map(formatCommand).join('\n');
      const keybindingLines = KEYBINDINGS.map((line) => `  ${line}`).join('\n');
      context.ui.info(
        `Commands:\n${commandLines}\n\nKeybindings:\n${keybindingLines}`,
      );
    },
  };
}
