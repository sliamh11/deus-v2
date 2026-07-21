/**
 * Unit tests for PendingPermissionRegistry (promoted verbatim from the
 * LIA-465 spike into production for the interactive-permission follow-up —
 * Amendment 2026-07-21 in docs/decisions/deus-v2-permission-rules.md).
 *
 * The spike's own end-to-end suite
 * (scripts/spikes/lia465_protocol_boundary_permission_spike.test.ts) keeps
 * proving the live HTTP/SSE round trip; this file pins the registry's OWN
 * contract in isolation: register/resolve round trip, unknown-id rejection,
 * and the fail-closed DENY_TIMEOUT_MS auto-deny (fake timers — never a real
 * 120s wait).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DENY_TIMEOUT_MS,
  PendingPermissionRegistry,
} from './permission-registry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingPermissionRegistry — register/resolve round trip', () => {
  it.each(['allow_once', 'allow_always', 'deny'] as const)(
    'register() resolves with the exact decision passed to resolve() (%s)',
    async (decision) => {
      const registry = new PendingPermissionRegistry();
      const pending = registry.register('req-1');
      expect(registry.size()).toBe(1);

      expect(registry.resolve('req-1', decision)).toBe(true);
      await expect(pending).resolves.toBe(decision);
      expect(registry.size()).toBe(0);
    },
  );

  it('a resolved entry is gone — resolving the same id again returns false', async () => {
    const registry = new PendingPermissionRegistry();
    const pending = registry.register('req-1');
    expect(registry.resolve('req-1', 'allow_once')).toBe(true);
    expect(registry.resolve('req-1', 'deny')).toBe(false);
    // The first decision stands; the second resolve changed nothing.
    await expect(pending).resolves.toBe('allow_once');
  });

  it('resolve() clears the pending timeout — no auto-deny timer survives an answered request', () => {
    vi.useFakeTimers();
    const registry = new PendingPermissionRegistry();
    void registry.register('req-1');
    expect(vi.getTimerCount()).toBe(1);

    registry.resolve('req-1', 'allow_once');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('concurrent requests resolve independently by id', async () => {
    const registry = new PendingPermissionRegistry();
    const a = registry.register('req-a');
    const b = registry.register('req-b');
    expect(registry.size()).toBe(2);

    expect(registry.resolve('req-b', 'deny')).toBe(true);
    expect(registry.resolve('req-a', 'allow_once')).toBe(true);
    await expect(a).resolves.toBe('allow_once');
    await expect(b).resolves.toBe('deny');
    expect(registry.size()).toBe(0);
  });
});

describe('PendingPermissionRegistry — unknown ids', () => {
  it('resolve() of a never-registered id returns false', () => {
    const registry = new PendingPermissionRegistry();
    expect(registry.resolve('never-registered', 'allow_once')).toBe(false);
  });
});

describe('PendingPermissionRegistry — fail-closed timeout (fake timers)', () => {
  it(`an unanswered request auto-denies after DENY_TIMEOUT_MS (${DENY_TIMEOUT_MS}ms) and is removed`, async () => {
    vi.useFakeTimers();
    const registry = new PendingPermissionRegistry();
    const pending = registry.register('req-timeout');

    // One tick short of the deadline: still pending, still registered.
    vi.advanceTimersByTime(DENY_TIMEOUT_MS - 1);
    expect(registry.size()).toBe(1);

    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBe('deny');
    expect(registry.size()).toBe(0);
    // A late human response after the timeout finds nothing to resolve.
    expect(registry.resolve('req-timeout', 'allow_once')).toBe(false);
  });

  it('a caller-supplied timeoutMs overrides the default', async () => {
    vi.useFakeTimers();
    const registry = new PendingPermissionRegistry();
    const pending = registry.register('req-short', 5_000);

    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBe('deny');
    expect(registry.size()).toBe(0);
  });
});
