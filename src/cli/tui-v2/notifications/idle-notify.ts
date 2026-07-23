/**
 * Idle desktop notifications — ported from `~/deus/tui/src/notify.rs` (the
 * v1 ratatui TUI's real, working implementation; read directly, 25 lines)
 * and the idle-decision logic wrapped around its call sites in
 * `~/deus/tui/src/app.rs` (read directly, lines 1858-1887): a macOS-only
 * `osascript -e 'display notification ...'` fire-and-forget call, gated by
 * two conditions — the user has been idle for a few seconds (so a
 * notification only fires when they've plausibly looked away, not on every
 * turn while they're actively watching the screen) and a notification
 * wasn't already sent in roughly the last 10 seconds (so a burst of fast
 * turns doesn't spam the OS notification center).
 *
 * `sendDesktopNotification` ports `notify::send`'s exact sanitization order
 * (strip newlines first, THEN escape backslashes, THEN escape double quotes
 * — reversing the last two would double-escape a backslash introduced by
 * quote-escaping) and its macOS-only guard (`!cfg!(target_os = "macos")` →
 * `process.platform !== 'darwin'`). `shouldNotifyIdle` ports the exact two
 * thresholds from `app.rs` (`last_activity.elapsed() > Duration::from_secs(5)`,
 * `last_notification.elapsed() > Duration::from_secs(10)`) as named,
 * overridable constants rather than a fresh guess at reasonable values.
 * `createIdleNotifier` is new: a small stateful wrapper Deus's real
 * `AppContainer.tsx` wiring (once it settles — see this step's final report)
 * calls on turn-completion (`ChatStreamBridgeDeps.onBusyChange(false)`) and
 * on every composer keystroke (as the "activity" signal), replacing
 * `app.rs`'s two `Instant` fields (`last_activity`, `last_notification`)
 * with the same two-timestamp model, injectable for testing (no real clock,
 * no real `osascript` spawn needed to test the decision logic).
 */

import { spawn } from 'node:child_process';
import { IS_MACOS, IS_WINDOWS } from '../../../platform.js';

export interface NotifySpawnDeps {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}

/** `src/platform.ts` is the only file allowed to read `process.platform` directly (ADR: platform-abstraction-layer) — this derives the same three-way value from its exported booleans instead. */
function detectedPlatform(): NodeJS.Platform {
  if (IS_WINDOWS) return 'win32';
  if (IS_MACOS) return 'darwin';
  return 'linux';
}

/** Strips control-breaking newlines, then escapes backslashes, then quotes — exact order from `notify.rs`. */
function sanitizeForAppleScript(value: string): string {
  return value
    .replace(/[\n\r]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/**
 * Fire-and-forget macOS notification via `osascript`. No-ops on any other
 * platform (mirrors `notify.rs`'s guard) and swallows spawn failures
 * (`notify.rs` also discards its `spawn()` result — a missing `osascript`
 * should never crash the TUI over a best-effort notification).
 */
export function sendDesktopNotification(
  title: string,
  body: string,
  deps: NotifySpawnDeps = {},
): void {
  const platform = deps.platform ?? detectedPlatform();
  if (platform !== 'darwin') return;

  const spawnFn = deps.spawnFn ?? spawn;
  const safeBody = sanitizeForAppleScript(body);
  const safeTitle = sanitizeForAppleScript(title);
  const script = `display notification "${safeBody}" with title "${safeTitle}"`;

  try {
    const child = spawnFn('osascript', ['-e', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref?.();
  } catch {
    // Best-effort — see module doc.
  }
}

export const DEFAULT_IDLE_THRESHOLD_MS = 5_000;
export const DEFAULT_NOTIFICATION_DEBOUNCE_MS = 10_000;

export interface IdleNotifyDecisionDeps {
  lastActivityAt: number;
  lastNotificationAt: number;
  now: number;
  idleThresholdMs?: number;
  debounceMs?: number;
}

/** Pure decision: ported from `app.rs`'s two-condition `if` guarding both real call sites (lines 1858, 1882-1883). */
export function shouldNotifyIdle(deps: IdleNotifyDecisionDeps): boolean {
  const idleThreshold = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const debounce = deps.debounceMs ?? DEFAULT_NOTIFICATION_DEBOUNCE_MS;
  return (
    deps.now - deps.lastActivityAt > idleThreshold &&
    deps.now - deps.lastNotificationAt > debounce
  );
}

export interface IdleNotifierDeps {
  now?: () => number;
  idleThresholdMs?: number;
  debounceMs?: number;
  send?: (title: string, body: string) => void;
}

export interface IdleNotifier {
  /** Call on every composer keystroke / user interaction — resets the idle clock. */
  recordActivity(): void;
  /**
   * Call when a turn completes (`onBusyChange(false)`). Sends a "Turn
   * complete" notification only if `shouldNotifyIdle` says so, and records
   * the send so the debounce window applies to the next call.
   */
  notifyTurnComplete(body: string): void;
}

export function createIdleNotifier(deps: IdleNotifierDeps = {}): IdleNotifier {
  const now = deps.now ?? (() => Date.now());
  const send =
    deps.send ?? ((title, body) => sendDesktopNotification(title, body));

  let lastActivityAt = now();
  // -Infinity, not 0: `shouldNotifyIdle`'s debounce check is `now -
  // lastNotificationAt > debounceMs` — seeding this at 0 would wrongly
  // suppress the very first notification whenever `now()` itself starts
  // near 0 (e.g. a test clock, or any clock not epoch-based), since
  // `now - 0` could be smaller than the debounce window even though no
  // notification has ever actually been sent yet.
  let lastNotificationAt = -Infinity;

  return {
    recordActivity(): void {
      lastActivityAt = now();
    },
    notifyTurnComplete(body: string): void {
      const currentTime = now();
      if (
        !shouldNotifyIdle({
          lastActivityAt,
          lastNotificationAt,
          now: currentTime,
          idleThresholdMs: deps.idleThresholdMs,
          debounceMs: deps.debounceMs,
        })
      ) {
        return;
      }
      send('Deus', body);
      lastNotificationAt = currentTime;
    },
  };
}
