import { describe, expect, it } from 'vitest';

import { RuntimeActivityBroadcaster } from '../../src/agent-runtimes/activity-broadcaster.js';
import {
  DENY_TIMEOUT_MS,
  PendingPermissionRegistry,
  createSyntheticPermissionRuntime,
  runLiveRoundTrip,
  startSpikeServer,
} from './lia465_protocol_boundary_permission_spike.js';

describe('PendingPermissionRegistry', () => {
  it('resolves the awaited promise with the posted decision', async () => {
    const registry = new PendingPermissionRegistry();
    const pending = registry.register('req-1', 5_000);
    expect(registry.size()).toBe(1);
    const resolved = registry.resolve('req-1', 'allow_always');
    expect(resolved).toBe(true);
    await expect(pending).resolves.toBe('allow_always');
    expect(registry.size()).toBe(0);
  });

  it('returns false when resolving an unknown requestId', () => {
    const registry = new PendingPermissionRegistry();
    expect(registry.resolve('never-registered', 'deny')).toBe(false);
  });

  it('denies on timeout when nobody responds', async () => {
    const registry = new PendingPermissionRegistry();
    const pending = registry.register('req-timeout', 20);
    await expect(pending).resolves.toBe('deny');
    expect(registry.size()).toBe(0);
  });

  it('exports the documented 120s default timeout', () => {
    expect(DENY_TIMEOUT_MS).toBe(120_000);
  });
});

describe('createSyntheticPermissionRuntime', () => {
  async function runWithDecision(decision: 'allow_once' | 'deny') {
    const registry = new PendingPermissionRegistry();
    const runtime = createSyntheticPermissionRuntime(registry, 'test_tool');
    const session = await runtime.startOrResume({
      prompt: 'x',
      groupFolder: 'g',
      chatJid: 'j',
      isControlGroup: false,
    });

    let capturedRequestId = '';
    const runPromise = runtime.runTurn(
      { prompt: 'x', groupFolder: 'g', chatJid: 'j', isControlGroup: false },
      session,
      (event) => {
        if (event.type === 'permission_request') {
          capturedRequestId = event.requestId;
        }
      },
    );

    for (let i = 0; i < 100 && capturedRequestId === ''; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedRequestId).not.toBe('');
    registry.resolve(capturedRequestId, decision);
    return runPromise;
  }

  it('returns success when the decision is allow_once', async () => {
    const result = await runWithDecision('allow_once');
    expect(result.status).toBe('success');
  });

  it('returns error when the decision is deny', async () => {
    const result = await runWithDecision('deny');
    expect(result.status).toBe('error');
    expect(result.error).toContain('permission_denied');
  });
});

describe('startSpikeServer', () => {
  it('serves SSE on /activity and 404s unknown routes', async () => {
    const broadcaster = new RuntimeActivityBroadcaster();
    const registry = new PendingPermissionRegistry();
    const server = await startSpikeServer(broadcaster, registry);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/nonexistent`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
      broadcaster.close();
    }
  });

  it('rejects a malformed decision value with 400 rather than resolving the registry', async () => {
    const broadcaster = new RuntimeActivityBroadcaster();
    const registry = new PendingPermissionRegistry();
    const server = await startSpikeServer(broadcaster, registry);
    try {
      const pending = registry.register('req-malformed', 200);
      const res = await fetch(
        `http://127.0.0.1:${server.port}/activity/req-malformed/respond`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'permission_response',
            requestId: 'req-malformed',
            decision: 'maybe',
          }),
        },
      );
      expect(res.status).toBe(400);
      // The malformed POST must not have resolved it — it should still
      // time out to 'deny' on its own schedule, not resolve as 'maybe'.
      await expect(pending).resolves.toBe('deny');
    } finally {
      await server.close();
      broadcaster.close();
    }
  });

  it('responding to an unknown requestId returns 404', async () => {
    const broadcaster = new RuntimeActivityBroadcaster();
    const registry = new PendingPermissionRegistry();
    const server = await startSpikeServer(broadcaster, registry);
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/activity/unknown-id/respond`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'permission_response',
            requestId: 'unknown-id',
            decision: 'deny',
          }),
        },
      );
      expect(res.status).toBe(404);
    } finally {
      await server.close();
      broadcaster.close();
    }
  });
});

describe('runLiveRoundTrip (real HTTP + real SSE + real registry, nothing mocked)', () => {
  it('carries permission_request over SSE and resolves on the posted decision', async () => {
    const result = await runLiveRoundTrip('allow_once');
    expect(result.requestReceivedOverSse).toBe(true);
    expect(result.observedRequestId).toBeDefined();
    expect(result.finalDecision).toBe('allow_once');
    expect(result.runResult.status).toBe('success');
  });

  it('propagates a deny decision through to the runtime result', async () => {
    const result = await runLiveRoundTrip('deny');
    expect(result.requestReceivedOverSse).toBe(true);
    expect(result.finalDecision).toBe('deny');
    expect(result.runResult.status).toBe('error');
  });
});
