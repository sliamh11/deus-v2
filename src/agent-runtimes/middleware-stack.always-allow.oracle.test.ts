/**
 * Independent integration oracle for session-scoped `allow_always` grants.
 *
 * Derived from the reviewed Track A contract before the production grant
 * module or middleware wiring existed. The real exported
 * `buildPermissionsMiddleware` is exercised directly; the grant dependency
 * is a contract-shaped observable store so missing read/write wiring fails
 * behaviorally even while the planned production class is absent.
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import {
  buildPermissionsMiddleware,
  type InteractivePermissionDeps,
} from './middleware-stack.js';
import { PendingPermissionRegistry } from './permission-registry.js';
import type { PermissionDecision, RuntimeEvent } from './types.js';

interface ObservableGrantStore {
  has(sessionId: string, toolName: string): boolean;
  add(sessionId: string, toolName: string): void;
  clear(sessionId: string): void;
}

function makeGrantStore(): ObservableGrantStore & {
  has: ReturnType<typeof vi.fn<ObservableGrantStore['has']>>;
  add: ReturnType<typeof vi.fn<ObservableGrantStore['add']>>;
} {
  const bySession = new Map<string, Set<string>>();
  return {
    has: vi.fn(
      (sessionId: string, toolName: string) =>
        bySession.get(sessionId)?.has(toolName) ?? false,
    ),
    add: vi.fn((sessionId: string, toolName: string) => {
      const tools = bySession.get(sessionId) ?? new Set<string>();
      tools.add(toolName);
      bySession.set(sessionId, tools);
    }),
    clear: (sessionId: string) => {
      bySession.delete(sessionId);
    },
  };
}

function makeToolCallRequest(
  toolName: string,
  id: string,
  args: Record<string, unknown> = {},
) {
  return {
    toolCall: { name: toolName, args, id, type: 'tool_call' as const },
    tool: undefined,
    state: {},
    runtime: {},
  };
}

async function invokeWrapToolCall(
  middleware: { wrapToolCall?: unknown },
  request: unknown,
  handler: (req: unknown) => Promise<ToolMessage> | ToolMessage,
): Promise<unknown> {
  const hook = middleware.wrapToolCall as (
    request: unknown,
    handler: unknown,
  ) => Promise<unknown> | unknown;
  return await hook(request, handler);
}

function buildInteractiveHarness(options: {
  sessionId: string;
  grants: ObservableGrantStore;
  decisions: PermissionDecision[];
}) {
  const registry = new PendingPermissionRegistry();
  const registerSpy = vi.spyOn(registry, 'register');
  const events: RuntimeEvent[] = [];
  const decisions = [...options.decisions];

  const interactive = {
    registry,
    sessionId: options.sessionId,
    alwaysAllowGrants: options.grants as never,
    eventSink: (event: RuntimeEvent) => {
      events.push(event);
      if (event.type !== 'permission_request') return;
      const decision = decisions.shift();
      if (decision === undefined) {
        throw new Error('oracle received an unexpected permission request');
      }
      registry.resolve(event.requestId, decision);
    },
  } as InteractivePermissionDeps;

  const built = buildPermissionsMiddleware(
    'interactive',
    undefined,
    interactive,
  );
  return { ...built, events, registry, registerSpy };
}

function successfulHandler(toolCallId: string) {
  return vi.fn(
    () => new ToolMessage({ content: 'ok', tool_call_id: toolCallId }),
  );
}

describe('@oracle permissions middleware — allow_always persistence', () => {
  // @oracle: allow_always writes before delegation, so the handler observes the grant.
  it('@oracle records an allow_always grant before calling the handler', async () => {
    const grants = makeGrantStore();
    const harness = buildInteractiveHarness({
      sessionId: 'session-A',
      grants,
      decisions: ['allow_always'],
    });
    const request = makeToolCallRequest('web_search', 'call-always-write', {
      query: 'deus',
    });
    const handler = vi.fn(() => {
      expect(grants.has('session-A', 'web_search')).toBe(true);
      return new ToolMessage({
        content: 'ok',
        tool_call_id: 'call-always-write',
      });
    });

    await invokeWrapToolCall(harness.middleware, request, handler);

    expect(grants.add).toHaveBeenCalledTimes(1);
    expect(grants.add).toHaveBeenCalledWith('session-A', 'web_search');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // @oracle: call 2 for the exact granted pair skips event/registry but keeps an audit record.
  it('@oracle second call for the same session and tool short-circuits the prompt and logs always-allow-grant', async () => {
    const grants = makeGrantStore();
    const harness = buildInteractiveHarness({
      sessionId: 'session-A',
      grants,
      // A correct implementation consumes only the first decision. The
      // second value lets the current no-persistence implementation finish,
      // then fail on the observable side-effect assertions below.
      decisions: ['allow_always', 'allow_once', 'deny'],
    });

    const firstHandler = successfulHandler('call-always-1');
    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_search', 'call-always-1', { query: 'first' }),
      firstHandler,
    );

    const secondHandler = vi.fn(() => {
      // The audit trail must exist before delegation, not be appended later.
      expect(harness.log.at(-1)).toMatchObject({
        toolName: 'web_search',
        decision: 'allow',
        source: 'always-allow-grant',
      });
      return new ToolMessage({
        content: 'ok',
        tool_call_id: 'call-always-2',
      });
    });
    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_search', 'call-always-2', { query: 'second' }),
      secondHandler,
    );

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(grants.add).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.registerSpy).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveLength(2);
    expect(harness.log[1]).toMatchObject({
      toolName: 'web_search',
      decision: 'allow',
      source: 'always-allow-grant',
    });

    // A third call with a different tool must still take the live prompt
    // path even though the session has an always-allow grant for web_search.
    const thirdHandler = successfulHandler('call-always-3');
    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_fetch', 'call-always-3', {
        url: 'https://example.test',
      }),
      thirdHandler,
    );

    expect(thirdHandler).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(2);
    expect(harness.events[1]).toMatchObject({
      type: 'permission_request',
      sessionId: 'session-A',
      toolName: 'web_fetch',
    });
    expect(harness.registerSpy).toHaveBeenCalledTimes(2);
    expect(harness.registry.size()).toBe(0);
  });
});

describe('@oracle permissions middleware — non-persistent and isolated decisions', () => {
  // @oracle: allow_once must never write a persistent grant (primary invariant).
  it('@oracle allow_once never adds a grant and the next identical call prompts again', async () => {
    const grants = makeGrantStore();
    const harness = buildInteractiveHarness({
      sessionId: 'session-A',
      grants,
      decisions: ['allow_once', 'allow_once'],
    });

    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_search', 'call-once-1'),
      successfulHandler('call-once-1'),
    );
    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_search', 'call-once-2'),
      successfulHandler('call-once-2'),
    );

    expect(grants.add).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(2);
    expect(harness.registerSpy).toHaveBeenCalledTimes(2);
  });

  // @oracle: omitting the optional store preserves the pre-ticket no-persistence behavior.
  it('@oracle omitted alwaysAllowGrants keeps allow_always scoped to each live call', async () => {
    const registry = new PendingPermissionRegistry();
    const registerSpy = vi.spyOn(registry, 'register');
    const events: RuntimeEvent[] = [];
    const { middleware } = buildPermissionsMiddleware(
      'interactive',
      undefined,
      {
        registry,
        sessionId: 'session-without-store',
        eventSink: (event) => {
          events.push(event);
          if (event.type === 'permission_request') {
            registry.resolve(event.requestId, 'allow_always');
          }
        },
      },
    );

    await invokeWrapToolCall(
      middleware,
      makeToolCallRequest('web_search', 'call-no-store-1'),
      successfulHandler('call-no-store-1'),
    );
    await invokeWrapToolCall(
      middleware,
      makeToolCallRequest('web_search', 'call-no-store-2'),
      successfulHandler('call-no-store-2'),
    );

    expect(events).toHaveLength(2);
    expect(registerSpy).toHaveBeenCalledTimes(2);
  });

  // @oracle: a same-session grant is an exact tool-name match, not a prefix/wildcard.
  it('@oracle a grant for web_search does not suppress a web_fetch prompt', async () => {
    const grants = makeGrantStore();
    const harness = buildInteractiveHarness({
      sessionId: 'session-A',
      grants,
      decisions: ['allow_always', 'allow_once'],
    });

    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_search', 'call-tool-1'),
      successfulHandler('call-tool-1'),
    );
    await invokeWrapToolCall(
      harness.middleware,
      makeToolCallRequest('web_fetch', 'call-tool-2'),
      successfulHandler('call-tool-2'),
    );

    expect(harness.events).toHaveLength(2);
    expect(harness.events[1]).toMatchObject({
      type: 'permission_request',
      sessionId: 'session-A',
      toolName: 'web_fetch',
    });
    expect(harness.registerSpy).toHaveBeenCalledTimes(2);
  });

  // @oracle: one process-wide grant store must still isolate session IDs.
  it('@oracle a grant for session A does not suppress session B for the same tool', async () => {
    const grants = makeGrantStore();
    const sessionA = buildInteractiveHarness({
      sessionId: 'session-A',
      grants,
      decisions: ['allow_always'],
    });
    const sessionB = buildInteractiveHarness({
      sessionId: 'session-B',
      grants,
      decisions: ['allow_once'],
    });

    await invokeWrapToolCall(
      sessionA.middleware,
      makeToolCallRequest('web_search', 'call-session-A'),
      successfulHandler('call-session-A'),
    );
    await invokeWrapToolCall(
      sessionB.middleware,
      makeToolCallRequest('web_search', 'call-session-B'),
      successfulHandler('call-session-B'),
    );

    expect(sessionA.events).toHaveLength(1);
    expect(sessionB.events).toHaveLength(1);
    expect(sessionB.events[0]).toMatchObject({
      type: 'permission_request',
      sessionId: 'session-B',
      toolName: 'web_search',
    });
    expect(sessionB.registerSpy).toHaveBeenCalledTimes(1);
  });
});
