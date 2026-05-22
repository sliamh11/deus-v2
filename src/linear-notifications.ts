/**
 * Pipeline notifications for Linear automation.
 *
 * Emits both macOS native notifications (osascript) and Linear issue
 * comments so the operator sees progress in both the OS notification
 * center and Linear's inbox.
 */

import { execFile } from 'child_process';
import { logger } from './logger.js';
import type { LinearContext } from './linear-dispatcher.js';

export function macosNotify(title: string, message: string): void {
  try {
    execFile(
      'osascript',
      [
        '-e',
        `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
      ],
      { timeout: 5000 },
      (err) => {
        if (err) logger.debug({ err }, 'notification: osascript failed');
      },
    );
  } catch {
    /* best-effort */
  }
}

export async function notifyPipelineStep(
  ctx: LinearContext,
  issueId: string,
  identifier: string,
  step: string,
  details?: string,
): Promise<void> {
  const short = `${identifier}: ${step}`;
  const full = details ? `${step}\n\n${details}` : step;

  macosNotify('Deus', short);

  try {
    await ctx.client.createComment({
      issueId,
      body: `**Pipeline** — ${full}`,
    });
  } catch (err) {
    logger.debug(
      { issueId, err },
      'notification: failed to post Linear comment',
    );
  }
}
