/**
 * `/exit` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/quitCommand.ts` (Apache-2.0, fetched and
 * read directly — 40 lines). The real `quitCommand` is named `quit` with
 * `altNames: ['exit']`, returns `{ type: 'quit', deleteSession, messages }`
 * where `messages` are synthetic `HistoryItem`s (a `/quit` echo + a
 * `duration` summary item) the caller renders before tearing down, and
 * `deleteSession` is set from a `--delete` flag.
 *
 * Deus flips the name/alt-name pairing (`/exit` primary, `/quit` alt) to
 * match this plan's own naming (`~/.claude/plans/deus-tui-gemini-fork.md`'s
 * "New files" list calls it `/exit`) and `tui/deus-tui-app.tsx`'s existing
 * `/exit`/`/quit` local-command precedent (both already accepted there).
 * `deleteSession`/`messages` are dropped: Deus's `TranscriptEntry` (unlike
 * Gemini's `HistoryItem`) has no `quit`/session-duration entry kind to
 * populate, and there is no `--delete`-a-session concept in
 * `ChatTransport` — nothing to wire either field to. The framework's
 * `{ type: 'quit' }` (this file's contribution) is what `registry.ts`'s
 * `applyActionReturn` maps to `context.onExit()`, mirroring
 * `tui/deus-tui-app.tsx`'s existing `/exit`/`/quit` handling
 * (`if (line === '/exit' || line === '/quit') onExit();`) — no
 * `transport.close()` call here either, matching that same precedent (only
 * the readline `deus chat` client's own loop calls `.close()` on its own
 * exit path, not the Ink TUI's).
 */

import { CommandKind, type SlashCommand } from './types.js';
import type { QuitActionReturn } from './types.js';

export const exitCommand: SlashCommand = {
  name: 'exit',
  altNames: ['quit'],
  description: 'Exit deus tui',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (): QuitActionReturn => ({ type: 'quit' }),
};
