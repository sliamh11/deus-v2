/**
 * `/plan on|off` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/planCommand.ts` (Apache-2.0, fetched and
 * read directly — 116 lines). The real `planCommand.ts` toggles
 * `config.setApprovalMode(ApprovalMode.PLAN)` (an enum with `DEFAULT`/
 * `AUTO_EDIT`/`YOLO`/`PLAN` members) and, when no args are given, reads back
 * an "approved plan" file from disk (`config.getApprovedPlanPath()`) and
 * echoes its content into the transcript.
 *
 * Deus's real equivalent is narrower and already shipped:
 * `ChatTransport.setPlanMode(enabled: boolean): Promise<NativeChatStatus>`
 * (`deus-native-chat-client.ts`) is a two-state boolean toggle, not a
 * four-state enum, and Deus has no "approved plan file" concept for a
 * no-args `/plan` to read back — there's nothing on disk to echo. So:
 * - `/plan on` / `/plan off` calls `setPlanMode` and reports the resulting
 *   mode from the real `NativeChatStatus` the transport returns (not an
 *   optimistic client-side guess).
 * - `/plan` with no args reports the *current* mode via `transport.status()`
 *   instead of reading a plan file — the closest honest analogue to
 *   planCommand.ts's "no args → show current plan state" branch.
 * - `/plan copy` (the real `subCommands` entry, which copies the approved
 *   plan file to the clipboard) is not ported: it depends entirely on the
 *   approved-plan-file concept above, which doesn't exist here either. Not
 *   silently dropped — named here as the reason `subCommands` isn't part of
 *   this framework port at all (see `types.ts`'s header).
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
} from './types.js';

function formatMode(mode: 'normal' | 'plan'): string {
  return mode === 'plan' ? 'Plan Mode' : 'Normal Mode';
}

async function planAction(
  context: SlashCommandContext,
  args: string,
): Promise<void> {
  const normalized = args.trim().toLowerCase();

  if (normalized === '') {
    const status = await context.services.transport.status();
    context.ui.info(`Currently in ${formatMode(status.mode)}.`);
    return;
  }

  if (normalized !== 'on' && normalized !== 'off') {
    context.ui.error('Usage: /plan on | /plan off | /plan');
    return;
  }

  const status = await context.services.transport.setPlanMode(
    normalized === 'on',
  );
  context.ui.info(`Switched to ${formatMode(status.mode)}.`);
}

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'View or switch plan mode (/plan on | /plan off)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: planAction,
};
