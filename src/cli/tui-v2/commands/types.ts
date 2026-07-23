/**
 * Slash-command framework skeleton for `tui-v2`, ported down from
 * google-gemini/gemini-cli's `packages/cli/src/ui/commands/types.ts`
 * (Apache-2.0, fetched and read directly — 257 lines) per the plan's
 * build-sequence step 9
 * (`~/.claude/plans/deus-tui-gemini-fork.md`).
 *
 * Gemini's real `CommandContext` is a large grouped-dependency bag (`services`
 * = agentContext/settings/git/logger, `ui` = 20+ methods covering dialogs,
 * corgi mode, vim mode, extension update state, agent-config dialogs, etc.,
 * `session` = stats/shell-allowlist) built for a system with auth flows, an
 * extensions marketplace, MCP prompts, agent definitions, and a dozen dialog
 * types. None of that exists in Deus's architecture today, so this file
 * keeps only the shape that has a real Deus caller:
 *
 * - `SlashCommandContext.ui` is a narrow capability interface (`info`/
 *   `error`/`clear`/`lastAssistantText`) rather than a direct dependency on
 *   `deus-tui-state.ts`'s `TuiState`/`TranscriptEntry` shape — deliberate:
 *   this keeps the command framework decoupled from the exact reducer
 *   representation (which a concurrent build-sequence step was actively
 *   revising while this step was written — command bodies should not need
 *   to change when transcript-entry internals do) and mirrors Gemini's own
 *   real design, where `context.ui` is also an abstracted capability bag,
 *   not the raw history array.
 * - `SlashCommandActionReturn` keeps the two variants that have a real
 *   pattern source here: `{ type: 'message', ... }` (copyCommand.ts's real
 *   return shape) and `{ type: 'quit' }` (quitCommand.ts's real return
 *   shape, minus the `deleteSession`/`messages` fields — Deus has no
 *   session-deletion-on-exit concept and no `HistoryItem` type to populate).
 *   Commands that don't need a typed return (plan/theme/clear/help/status)
 *   call `context.ui.info`/`context.ui.error`/`context.ui.clear` directly as
 *   a side effect instead, exactly like clearCommand.ts/themeCommand.ts/
 *   helpCommand.ts/planCommand.ts do in the real source (both styles coexist
 *   in Gemini's own command set — this ports the mix faithfully rather than
 *   forcing every command through one shape).
 * - `CommandKind` collapses to a single `BUILT_IN` member — Gemini's other
 *   six (`USER_FILE`, `WORKSPACE_FILE`, `EXTENSION_FILE`, `MCP_PROMPT`,
 *   `AGENT`, `SKILL`) all describe command *sources* Deus doesn't have yet
 *   (no user-defined command files, no extensions system, no MCP prompts, no
 *   agent/skill registry reachable from the composer). Kept as an enum
 *   (rather than deleted outright) so a future command source has a real
 *   slot to extend into, matching this file's role as "framework skeleton".
 * - Dropped entirely (no Deus caller, no Deus equivalent to wire it to):
 *   `hidden`, `suggestionGroup`, `isSafeConcurrent`, `extensionName`/
 *   `extensionId`, `mcpServerName`, `completion`/`showCompletionLoading`
 *   (command-argument autocomplete — the fuzzy command palette, design
 *   decision #4, is explicitly deferred past this PR's MVP), `takesArgs`,
 *   `subCommands` (only `/plan copy` used this in the real source, and
 *   Deus's `/plan` has no approved-plan-file concept to copy — see
 *   `planCommand.ts`'s header in this directory for the full scoping note).
 *
 * See LIA-473's plan build-sequence
 * step 9.
 */

import type { ChatTransport } from '../../deus-native-chat-client.js';

/** Narrow structural interface `themes/theme-manager.ts`'s real `themeManager` singleton satisfies without this file importing it directly. */
export interface ThemeManagerLike {
  getActiveTheme(): { name: string };
  setActiveTheme(themeName: string | undefined): boolean;
  getAvailableThemes(): Array<{
    name: string;
    type: string;
    isCustom?: boolean;
  }>;
}

export enum CommandKind {
  BUILT_IN = 'built-in',
}

/** The raw, already-parsed pieces of one `/name args` line. */
export interface SlashCommandInvocation {
  /** The raw, untrimmed input string the user typed, including the leading `/`. */
  raw: string;
  /** The command name that was matched (lowercased, no leading `/`). */
  name: string;
  /** Everything after the command name, trimmed. */
  args: string;
}

export interface SlashCommandServices {
  /** For `/plan`, `/status`, `/exit` — the same transport `deus-chat-stream-bridge.ts` drives. */
  transport: ChatTransport;
  themeManager: ThemeManagerLike;
  /** Writes text to the system clipboard; rejects on failure. Injected so `/copy` is testable without a real clipboard. */
  clipboard: (text: string) => Promise<void>;
}

export interface SlashCommandUi {
  /** Appends one informational line to the transcript. */
  info(text: string): void;
  /** Appends one error line to the transcript. */
  error(text: string): void;
  /** Clears the transcript. */
  clear(): void;
  /** The text of the most recent `assistant`-kind transcript entry, or `undefined` if none exists yet. */
  lastAssistantText(): string | undefined;
}

export interface SlashCommandContext {
  invocation: SlashCommandInvocation;
  services: SlashCommandServices;
  ui: SlashCommandUi;
  cwd: string;
  /** Requests app shutdown — mirrors `AppStateValue.onExit`. */
  onExit: () => void;
}

/** copyCommand.ts's real return shape (minus nothing — this one ports 1:1). */
export interface MessageActionReturn {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
}

/** quitCommand.ts's real return shape, minus `deleteSession`/`messages` (no Deus equivalent — see this file's header). */
export interface QuitActionReturn {
  type: 'quit';
}

export type SlashCommandActionReturn =
  MessageActionReturn | QuitActionReturn | void;

export interface SlashCommand {
  name: string;
  altNames?: string[];
  description: string;
  kind: CommandKind;
  /**
   * Kept for shape-parity with the ported `SlashCommand` contract even
   * though `tui-v2` has no slash-completion suggestion UI yet to consume it
   * (see this file's header) — a future completion overlay can read it
   * without every command definition needing a new field added later.
   */
  autoExecute?: boolean;
  action: (
    context: SlashCommandContext,
    args: string,
  ) => SlashCommandActionReturn | Promise<SlashCommandActionReturn>;
}
