/**
 * Command registry + dispatcher for `tui-v2`'s slash-command framework
 * (`types.ts`'s header has the full port rationale). Gemini's own
 * command-resolution logic lives inline in `useSlashCommandProcessor.ts`
 * (a ~600-line hook entangled with dialog state, shell-confirmation flow,
 * and MCP-prompt commands) — not portable per the plan's "Critical
 * reconciled finding" (client-side state-machine ownership Deus's
 * architecture doesn't share). This file is a new, narrow replacement: parse
 * one raw input line, find the matching `SlashCommand` by name or alt name,
 * run its `action`, and apply the small `SlashCommandActionReturn` contract
 * (`message` / `quit` / `void`) against `context.ui`/`context.onExit`.
 *
 * Deliberately has NO Ink/React import — pure and independently testable,
 * same convention as `deus-tui-state.ts`/`deus-tui-permission-decision.ts`.
 */

import type {
  SlashCommand,
  SlashCommandActionReturn,
  SlashCommandContext,
} from './types.js';

export interface SlashCommandRegistry {
  /** All registered commands, in registration order (the order `/help` lists them in). */
  readonly commands: readonly SlashCommand[];
  /** Look up a command by its primary name or any alt name (case-insensitive). */
  find(name: string): SlashCommand | undefined;
}

export function createSlashCommandRegistry(
  commands: readonly SlashCommand[],
): SlashCommandRegistry {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    byName.set(command.name.toLowerCase(), command);
    for (const alt of command.altNames ?? []) {
      byName.set(alt.toLowerCase(), command);
    }
  }
  return {
    commands,
    find: (name: string) => byName.get(name.toLowerCase()),
  };
}

/**
 * Splits one raw line into `{ name, args }` if it looks like a slash
 * command (starts with `/` followed by a non-whitespace character —
 * a bare `/` or `/ foo` is not a command, it falls through to chat like any
 * other text), or returns `undefined` otherwise. Never throws.
 */
export function parseSlashCommandLine(
  raw: string,
): { name: string; args: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const rest = trimmed.slice(1);
  if (rest === '' || /^\s/.test(rest)) return undefined;
  const spaceIndex = rest.search(/\s/);
  if (spaceIndex === -1) {
    return { name: rest.toLowerCase(), args: '' };
  }
  return {
    name: rest.slice(0, spaceIndex).toLowerCase(),
    args: rest.slice(spaceIndex + 1).trim(),
  };
}

export const UNKNOWN_COMMAND_MESSAGE = (name: string): string =>
  `Unknown command: /${name}. Type /help to see available commands.`;

export interface ExecuteSlashCommandResult {
  /** True when `raw` was a recognized `/command` and its action ran (or was rejected as unknown) — the caller should NOT also forward `raw` to the chat transport. False means `raw` was not a slash command at all and should be treated as a normal chat prompt. */
  handled: boolean;
}

/**
 * Parses and, if `raw` is a recognized slash command, runs it against
 * `registry`/`context`. Applies the command's `SlashCommandActionReturn` to
 * `context.ui`/`context.onExit` itself, so callers never need to inspect the
 * action's return value directly — mirroring how Gemini's real
 * `useSlashCommandProcessor.ts` centralizes handling of every
 * `SlashCommandActionReturn` variant in one place rather than pushing that
 * switch out to every call site.
 */
export async function executeSlashCommand(
  registry: SlashCommandRegistry,
  raw: string,
  context: SlashCommandContext,
): Promise<ExecuteSlashCommandResult> {
  const parsed = parseSlashCommandLine(raw);
  if (!parsed) return { handled: false };

  const command = registry.find(parsed.name);
  if (!command) {
    context.ui.error(UNKNOWN_COMMAND_MESSAGE(parsed.name));
    return { handled: true };
  }

  const invocationContext: SlashCommandContext = {
    ...context,
    invocation: { raw, name: parsed.name, args: parsed.args },
  };

  let result: SlashCommandActionReturn;
  try {
    result = await command.action(invocationContext, parsed.args);
  } catch (error) {
    context.ui.error(
      `/${parsed.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { handled: true };
  }

  applyActionReturn(result, context);
  return { handled: true };
}

function applyActionReturn(
  result: SlashCommandActionReturn,
  context: SlashCommandContext,
): void {
  if (!result) return;
  switch (result.type) {
    case 'message':
      if (result.messageType === 'error') {
        context.ui.error(result.content);
      } else {
        context.ui.info(result.content);
      }
      return;
    case 'quit':
      context.onExit();
      return;
    default: {
      const unhandled: never = result;
      void unhandled;
    }
  }
}
