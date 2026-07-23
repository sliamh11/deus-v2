/**
 * `/status` — Deus-native, no Gemini pattern source (Gemini has no
 * equivalent single-line diagnostics command; its closest analogues,
 * `aboutCommand`/`statsCommand`, are both in this plan's deferred list).
 * Mirrors `deus-native-chat-client.ts`'s `renderStatus` output for the
 * readline `deus chat` client exactly (backend / mode+permissionProfile /
 * session / state / output), so `/status` reads the same in both UIs.
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

async function statusAction(context: SlashCommandContext): Promise<void> {
  const status = await context.services.transport.status();
  context.ui.info(
    [
      `Backend: ${status.backend}`,
      `Mode:    ${status.mode} (${status.permissionProfile})`,
      `Session: ${status.sessionId ?? 'not started'}`,
      `State:   ${status.state}`,
      `Output:  ${status.output}`,
    ].join('\n'),
  );
}

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show backend, mode, session, and connection diagnostics',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: statusAction,
};
