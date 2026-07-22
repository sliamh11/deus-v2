/**
 * Documented substitute for the live credentialed daemon smoke test named in
 * LIA-470's plan (real web_search call, allow_always, confirm suppression).
 * Not run: no provider credentials reachable from this worktree checkout,
 * and a full daemon boot has real external side effects (Linear mutations,
 * container cleanup) unsafe to trigger unattended. Instead, this exercises
 * the REAL buildMiddlewareStack/SessionAlwaysAllowGrants/
 * PendingPermissionRegistry through LangChain's real createAgent over two
 * separate turns sharing one process-wide grant store -- proving genuine
 * cross-turn persistence -- but never touches the daemon, HTTP transport, or
 * a real model provider.
 */

import { describe, expect, it } from 'vitest';
import { createAgent, tool, FakeToolCallingModel } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

import { buildMiddlewareStack } from './middleware-stack.js';
import { PendingPermissionRegistry } from './permission-registry.js';
import { SessionAlwaysAllowGrants } from './always-allow-grants.js';
import type { RuntimeEvent } from './types.js';

describe('@integration allow_always persistence across two real agent turns (LIA-470 live-run substitute)', () => {
  it('turn 1 prompts and records the grant; turn 2 (fresh middleware, same process-wide store) short-circuits the prompt and still runs the real tool', async () => {
    // Process-wide singletons, constructed ONCE -- exactly src/index.ts's
    // `permissionRegistry`/`alwaysAllowGrants` wiring, not one per turn.
    const registry = new PendingPermissionRegistry();
    const alwaysAllowGrants = new SessionAlwaysAllowGrants();
    const sessionId = 'integration-session-1';

    const searchSpy = { calls: 0 };
    const webSearchTool = tool(
      async (args: { query: string }) => {
        searchSpy.calls += 1;
        return `search-result:${args.query}`;
      },
      {
        name: 'web_search',
        description: 'stub production-shaped web_search tool',
        schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    );

    const permissionRequestEvents: RuntimeEvent[] = [];

    function runTurn(query: string, toolCallId: string) {
      // A fresh middleware stack per turn -- matching
      // `buildPermissionsMiddleware()` being "rebuilt fresh every turn"
      // while the grant store stays the process-wide singleton above.
      const { middleware } = buildMiddlewareStack(
        { wardens: false, memory: false, telemetry: false },
        {
          permissionProfile: 'interactive',
          permissionInteractive: {
            registry,
            sessionId,
            alwaysAllowGrants,
            eventSink: (event: RuntimeEvent) => {
              permissionRequestEvents.push(event);
              if (event.type !== 'permission_request') return;
              // The live human response this test substitutes for:
              // 'allow_always' on the only prompt this whole test expects.
              registry.resolve(event.requestId, 'allow_always');
            },
          },
        },
      );

      const model = new FakeToolCallingModel({
        toolCalls: [
          [{ name: 'web_search', args: { query }, id: toolCallId }],
          [],
        ],
      });

      const agent = createAgent({
        model,
        tools: [webSearchTool],
        middleware,
      });

      return agent.invoke({
        messages: [{ role: 'user', content: `search for ${query}` }],
      });
    }

    // -- Turn 1: no prior grant -- the live 'ask' path fires once. --------
    const firstResult = await runTurn('first-query', 'call_turn_1');

    expect(searchSpy.calls).toBe(1);
    expect(permissionRequestEvents).toHaveLength(1);
    expect(permissionRequestEvents[0]).toMatchObject({
      type: 'permission_request',
      sessionId,
      toolName: 'web_search',
    });
    expect(alwaysAllowGrants.has(sessionId, 'web_search')).toBe(true);

    const firstToolMessage = (
      firstResult as { messages: unknown[] }
    ).messages.find(
      (m): m is ToolMessage =>
        ToolMessage.isInstance(m as never) &&
        (m as ToolMessage).tool_call_id === 'call_turn_1',
    );
    expect(firstToolMessage).toBeDefined();
    expect(firstToolMessage?.status).not.toBe('error');
    expect(String(firstToolMessage?.content)).toContain(
      'search-result:first-query',
    );

    // -- Turn 2: SAME session + SAME tool, a genuinely separate agent turn
    // with a freshly rebuilt middleware stack. The grant recorded in turn 1
    // must suppress the live prompt while the real tool still executes. ---
    const secondResult = await runTurn('second-query', 'call_turn_2');

    // The controlling assertion: no second permission_request was ever
    // emitted -- if it had been, the eventSink above would have pushed a
    // second entry (and there is no second decision queued to answer it).
    expect(permissionRequestEvents).toHaveLength(1);
    expect(searchSpy.calls).toBe(2);

    const secondToolMessage = (
      secondResult as { messages: unknown[] }
    ).messages.find(
      (m): m is ToolMessage =>
        ToolMessage.isInstance(m as never) &&
        (m as ToolMessage).tool_call_id === 'call_turn_2',
    );
    expect(secondToolMessage).toBeDefined();
    expect(secondToolMessage?.status).not.toBe('error');
    expect(String(secondToolMessage?.content)).toContain(
      'search-result:second-query',
    );

    // registry.size() returning to 0 after each resolved request confirms
    // turn 2 never registered a second pending request either.
    expect(registry.size()).toBe(0);
  });
});
