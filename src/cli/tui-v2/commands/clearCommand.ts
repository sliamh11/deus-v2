/**
 * `/clear` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/clearCommand.ts` (Apache-2.0, fetched and
 * read directly — 88 lines). The real `clearCommand` does two things:
 * clears the visible history/screen (`context.ui.clear()`) AND starts a
 * genuinely new backend session — firing `SessionEnd`/`SessionStart` hooks,
 * resetting `geminiClient`'s chat, generating a fresh session ID, closing
 * browser sessions, flushing telemetry.
 *
 * Only the first half is portable. `ChatTransport` (`deus-native-chat-client.ts`)
 * exposes exactly `turn`/`respondPermission`/`setPlanMode`/`status`/`close` —
 * there is no "start a new session, keep the connection" call. Resetting the
 * backend session is a known gap, not silently dropped: `/clear` here only
 * clears the client-side transcript view (`context.ui.clear()`); the
 * daemon-side conversation this session is bound to is untouched, so
 * anything sent after `/clear` still has full prior context server-side.
 * This mirrors the plan's own "known gap, name it" precedent (`/rewind`'s
 * scoping note) rather than inventing a fake reset.
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

function clearAction(context: SlashCommandContext): void {
  context.ui.clear();
  context.ui.info(
    'Transcript cleared. Note: the backend session itself was not reset — the agent still has your prior conversation as context.',
  );
}

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['new'],
  description: 'Clear the visible transcript',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: clearAction,
};
