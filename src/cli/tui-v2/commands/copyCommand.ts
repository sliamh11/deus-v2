/**
 * `/copy` — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/commands/copyCommand.ts` (Apache-2.0, fetched and
 * read directly — 70 lines). The real `copyCommand` reads
 * `context.services.agentContext.geminiClient.getChat().getHistory()`,
 * filters for the last `role === 'model'` message, joins its text parts, and
 * copies that via a settings-aware `copyToClipboard` util — returning the
 * exact three `{ type: 'message', ... }` shapes this file preserves:
 * "No output in history" (no assistant message yet), the success message,
 * and a clipboard-failure error message.
 *
 * Deus's history source is `context.ui.lastAssistantText()`
 * (`AppContainer.tsx`'s wiring reads the last `kind: 'assistant'`
 * `TranscriptEntry`, the client-side equivalent of filtering for
 * `role === 'model'`) instead of a `GeminiChat` history object — same
 * lookup, narrower dependency. `utils/clipboard.ts`'s `createClipboardWriter`
 * replaces the settings-aware `copyToClipboard` (see that file's header for
 * why: no Deus settings surface to look up a clipboard-command override
 * from).
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandContext,
  type MessageActionReturn,
} from './types.js';

async function copyAction(
  context: SlashCommandContext,
): Promise<MessageActionReturn> {
  const lastAiOutput = context.ui.lastAssistantText();

  if (!lastAiOutput) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No output in history',
    };
  }

  try {
    await context.services.clipboard(lastAiOutput);
    return {
      type: 'message',
      messageType: 'info',
      content: 'Last output copied to the clipboard',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to copy to the clipboard. ${message}`,
    };
  }
}

export const copyCommand: SlashCommand = {
  name: 'copy',
  description: "Copy the assistant's last reply to the clipboard",
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: copyAction,
};
