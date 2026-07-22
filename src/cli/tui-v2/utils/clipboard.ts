/**
 * Cross-platform clipboard writer for `/copy` (`commands/copyCommand.ts`).
 * Gemini's own `copyToClipboard` (`packages/cli/src/ui/utils/commandUtils.ts`)
 * wasn't fetched/ported verbatim — its real signature takes a whole
 * `Settings` object (`copyToClipboard(text, settings)`) to look up a
 * user-configurable clipboard command override, a Deus settings surface that
 * doesn't exist here. This is a new, narrower implementation covering the
 * same three platform-native commands any such utility has no real
 * alternative to (`pbcopy` / `xclip` / `clip.exe`), spawn-based rather than
 * shelling out through a string command (per this repo's general shell-
 * injection posture — args passed as an argv array, never interpolated into
 * a shell string).
 *
 * Exported as a factory (`createClipboardWriter`), not a bare function,
 * specifically so `commands/copyCommand.test.ts` can inject a fake
 * `spawn` and never actually touch the real system clipboard in CI.
 */

import { spawn } from 'node:child_process';
import { IS_MACOS, IS_WINDOWS } from '../../../platform.js';

export interface ClipboardSpawnDeps {
  platform?: NodeJS.Platform;
  /** Same shape as `node:child_process`'s `spawn` — narrowed to what this file uses. */
  spawnFn?: typeof spawn;
}

/** `src/platform.ts` is the only file allowed to read `process.platform` directly (ADR: platform-abstraction-layer) — this derives the same three-way value from its exported booleans instead. */
function detectedPlatform(): NodeJS.Platform {
  if (IS_WINDOWS) return 'win32';
  if (IS_MACOS) return 'darwin';
  return 'linux';
}

function commandFor(
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } | undefined {
  switch (platform) {
    case 'darwin':
      return { cmd: 'pbcopy', args: [] };
    case 'win32':
      return { cmd: 'clip', args: [] };
    default:
      // Most Linux desktops have one of these; xclip is far more common.
      return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
}

/**
 * Writes `text` to the system clipboard by piping it to a platform-native
 * clipboard command's stdin. Rejects if the command is missing, exits
 * non-zero, or the platform has no known clipboard command.
 */
export function createClipboardWriter(
  deps: ClipboardSpawnDeps = {},
): (text: string) => Promise<void> {
  const platform = deps.platform ?? detectedPlatform();
  const spawnFn = deps.spawnFn ?? spawn;
  const resolved = commandFor(platform);

  return (text: string): Promise<void> => {
    if (!resolved) {
      return Promise.reject(
        new Error(`No known clipboard command for platform "${platform}".`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawnFn(resolved.cmd, resolved.args, {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.once('error', (error) => reject(error));
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${resolved.cmd} exited with code ${code}`));
      });
      child.stdin?.end(text);
    });
  };
}
