import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  createIdleNotifier,
  sendDesktopNotification,
  shouldNotifyIdle,
} from './idle-notify.js';

describe('sendDesktopNotification', () => {
  it('spawns osascript with a sanitized display-notification script on darwin', () => {
    const spawnFn = vi.fn(() =>
      Object.assign(new EventEmitter(), { unref: vi.fn() }),
    );
    sendDesktopNotification('Deus', 'Turn complete', {
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      'osascript',
      ['-e', 'display notification "Turn complete" with title "Deus"'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  });

  it('is a no-op on any non-darwin platform', () => {
    const spawnFn = vi.fn();
    sendDesktopNotification('Deus', 'hi', {
      platform: 'linux',
      spawnFn: spawnFn as never,
    });
    sendDesktopNotification('Deus', 'hi', {
      platform: 'win32',
      spawnFn: spawnFn as never,
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('sanitizes newlines, backslashes, and quotes in the body/title (strip newlines, THEN escape backslash, THEN quote — order matters)', () => {
    const spawnFn = vi.fn(() =>
      Object.assign(new EventEmitter(), { unref: vi.fn() }),
    );
    sendDesktopNotification('Ti"tle', 'line one\nline "two"\\ end', {
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    const call = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(call[1][1]).toBe(
      'display notification "line one line \\"two\\"\\\\ end" with title "Ti\\"tle"',
    );
  });

  it('does not throw when spawn itself throws (best-effort)', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('no osascript');
    });
    expect(() =>
      sendDesktopNotification('Deus', 'hi', {
        platform: 'darwin',
        spawnFn: spawnFn as never,
      }),
    ).not.toThrow();
  });
});

describe('shouldNotifyIdle', () => {
  it('is true once the user has been idle past the threshold and the debounce has elapsed', () => {
    expect(
      shouldNotifyIdle({
        lastActivityAt: 0,
        lastNotificationAt: 0,
        now: 20_000,
      }),
    ).toBe(true);
  });

  it('is false while the user is still within the idle threshold (actively watching)', () => {
    expect(
      shouldNotifyIdle({
        lastActivityAt: 18_000,
        lastNotificationAt: 0,
        now: 20_000,
      }),
    ).toBe(false);
  });

  it('is false within the debounce window even if idle', () => {
    expect(
      shouldNotifyIdle({
        lastActivityAt: 0,
        lastNotificationAt: 19_000,
        now: 20_000,
      }),
    ).toBe(false);
  });

  it('honors custom thresholds', () => {
    expect(
      shouldNotifyIdle({
        lastActivityAt: 0,
        lastNotificationAt: 0,
        now: 3_000,
        idleThresholdMs: 1_000,
        debounceMs: 1_000,
      }),
    ).toBe(true);
  });
});

describe('createIdleNotifier', () => {
  it('sends a notification on turn completion once idle past the threshold', () => {
    let clock = 0;
    const send = vi.fn();
    const notifier = createIdleNotifier({ now: () => clock, send });

    clock = 6_000; // 6s since creation (activity at t=0) — past the 5s default threshold
    notifier.notifyTurnComplete('Turn complete');
    expect(send).toHaveBeenCalledWith('Deus', 'Turn complete');
  });

  it('does not send while the user was recently active', () => {
    let clock = 0;
    const send = vi.fn();
    const notifier = createIdleNotifier({ now: () => clock, send });

    clock = 2_000; // only 2s since creation — within the 5s default threshold
    notifier.notifyTurnComplete('too soon');
    expect(send).not.toHaveBeenCalled();
  });

  it('recordActivity resets the idle clock, suppressing a notification that would otherwise fire', () => {
    let clock = 0;
    const send = vi.fn();
    const notifier = createIdleNotifier({ now: () => clock, send });

    clock = 4_000;
    notifier.recordActivity(); // user typed again just before the threshold
    clock = 6_000; // only 2s since the reset activity — still within the 5s threshold
    notifier.notifyTurnComplete('x');
    expect(send).not.toHaveBeenCalled();
  });

  it('debounces a second notification sent shortly after the first', () => {
    let clock = 0;
    const send = vi.fn();
    const notifier = createIdleNotifier({ now: () => clock, send });

    clock = 6_000;
    notifier.notifyTurnComplete('first');
    expect(send).toHaveBeenCalledTimes(1);

    clock = 10_000; // only 4s after the first notification — within the 10s debounce
    notifier.notifyTurnComplete('second');
    expect(send).toHaveBeenCalledTimes(1);

    clock = 17_000; // 11s after the first notification — debounce has elapsed
    notifier.notifyTurnComplete('third');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
