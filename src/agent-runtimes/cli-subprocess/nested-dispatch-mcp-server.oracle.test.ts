/**
 * Independent oracle for LIA-454 nested-dispatch MCP deny enforcement.
 *
 * @oracle Authored from the LIA-454 contract before
 * `nested-dispatch-mcp-server.ts` existed and without seeing an
 * implementation.
 *
 * Assumed export:
 *   handleNestedDispatchToolCall(
 *     encodedContext: string | undefined,
 *     toolName: 'web_search' | 'web_fetch',
 *     args: Record<string, unknown>,
 *     realAction: (args: Record<string, unknown>) => Promise<McpToolResult>,
 *   ): Promise<McpToolResult>
 *
 * `encodedContext` represents DEUS_NESTED_DISPATCH_CONTEXT as read at server
 * startup. If the implementation uses different exports, adapt only the
 * import/seam adapter; preserve these assertions.
 *
 * Existing `default` and `read-only` profiles both allow web_fetch. The deny
 * case therefore installs a realistic test-only named profile through the
 * resolver while retaining the production evaluatePermission function.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const permissionCalls = vi.hoisted(() => ({
  evaluatePermission: vi.fn(),
}));

vi.mock('../permission-rules.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../permission-rules.js')>();

  return {
    ...actual,
    resolvePermissionProfile: (name: string) => {
      if (name === 'oracle-deny-web-fetch') {
        return {
          rules: [{ toolName: 'web_fetch', decision: 'deny' as const }],
          defaultDecision: 'allow' as const,
        };
      }
      return actual.resolvePermissionProfile(name);
    },
    evaluatePermission: (
      policy: Parameters<typeof actual.evaluatePermission>[0],
      toolName: string,
    ) => {
      permissionCalls.evaluatePermission(policy, toolName);
      return actual.evaluatePermission(policy, toolName);
    },
  };
});

// Intentionally unresolved until the LIA-454 implementation lands.
import { handleNestedDispatchToolCall } from './nested-dispatch-mcp-server.js';

interface McpToolResult {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

const WEB_FETCH_ARGS = { url: 'https://example.com/oracle' };

function encodedContext(permissionProfile: string | null): string {
  return JSON.stringify({
    permissionProfile,
    wardenCwd: '/oracle/worktree',
    toolBrokerContext: {
      cwd: '/oracle/worktree',
      groupFolder: 'oracle-fixture',
      chatJid: 'oracle-fixture@example.invalid',
      isControlGroup: true,
    },
    allowedWebFetchHosts: ['example.com'],
  });
}

function successfulNetworkResult(): McpToolResult {
  return {
    content: [{ type: 'text', text: 'oracle-network-success' }],
  };
}

describe('@oracle LIA-454 nested-dispatch MCP permission enforcement', () => {
  beforeEach(() => {
    permissionCalls.evaluatePermission.mockClear();
  });

  it('@oracle A+B: denied web_fetch returns an MCP error and never invokes the real action', async () => {
    // @oracle: Controlling assertions A+B — authorization occurs before the
    // network boundary and denial is model-visible as an MCP tool error.
    const realFetch = vi.fn(async () => successfulNetworkResult());

    const result = await handleNestedDispatchToolCall(
      encodedContext('oracle-deny-web-fetch'),
      'web_fetch',
      WEB_FETCH_ARGS,
      realFetch,
    );

    expect(permissionCalls.evaluatePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [{ toolName: 'web_fetch', decision: 'deny' }],
      }),
      'web_fetch',
    );
    expect(realFetch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/permission_denied|denied|blocked/i),
        }),
      ]),
    );
    expect(JSON.stringify(result.content)).toContain('web_fetch');
  });

  it('@oracle C: allowed web_fetch invokes the real action exactly once and returns a non-error result', async () => {
    // @oracle: Controlling assertion C — the real default profile permits
    // web_fetch, so enforcement must delegate rather than deny everything.
    const realFetch = vi.fn(async () => successfulNetworkResult());

    const result = await handleNestedDispatchToolCall(
      encodedContext('default'),
      'web_fetch',
      WEB_FETCH_ARGS,
      realFetch,
    );

    expect(permissionCalls.evaluatePermission).toHaveBeenCalledWith(
      expect.any(Object),
      'web_fetch',
    );
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{ definitely-not-valid-json'],
  ] as const)(
    '@oracle D: %s DEUS_NESTED_DISPATCH_CONTEXT fails closed',
    async (_caseName, rawContext) => {
      // @oracle: Controlling assertion D — absent or unparseable startup
      // context denies before network access; there is no allow-all fallback.
      const realFetch = vi.fn(async () => successfulNetworkResult());

      const result = await handleNestedDispatchToolCall(
        rawContext,
        'web_fetch',
        WEB_FETCH_ARGS,
        realFetch,
      );

      expect(realFetch).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringMatching(/permission|context|denied|blocked/i),
          }),
        ]),
      );
    },
  );
});
