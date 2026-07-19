import { describe, expect, it, vi } from 'vitest';

import {
  createNestedDispatchMcpServer,
  handleNestedDispatchToolCall,
  parseNestedDispatchContext,
} from './nested-dispatch-mcp-server.js';

function validEncodedContext(
  overrides: Partial<{
    permissionProfile: string | null;
    allowedWebFetchHosts: string[];
  }> = {},
): string {
  return JSON.stringify({
    permissionProfile: overrides.permissionProfile ?? 'default',
    wardenCwd: '/test/worktree',
    toolBrokerContext: {
      cwd: '/test/worktree',
      groupFolder: 'test-group',
      chatJid: 'test@example.invalid',
      isControlGroup: true,
    },
    allowedWebFetchHosts: overrides.allowedWebFetchHosts ?? ['example.com'],
  });
}

describe('parseNestedDispatchContext', () => {
  it('returns undefined for undefined input', () => {
    expect(parseNestedDispatchContext(undefined)).toBeUndefined();
  });

  it('returns undefined for unparseable JSON', () => {
    expect(parseNestedDispatchContext('{not valid')).toBeUndefined();
  });

  it('returns undefined for valid JSON missing required fields', () => {
    expect(parseNestedDispatchContext(JSON.stringify({}))).toBeUndefined();
    expect(
      parseNestedDispatchContext(JSON.stringify({ wardenCwd: '/x' })),
    ).toBeUndefined();
  });

  it('returns undefined for a JSON primitive (not an object)', () => {
    expect(parseNestedDispatchContext('"just a string"')).toBeUndefined();
    expect(parseNestedDispatchContext('42')).toBeUndefined();
    expect(parseNestedDispatchContext('null')).toBeUndefined();
  });

  it('parses a well-formed context', () => {
    const context = parseNestedDispatchContext(validEncodedContext());
    expect(context).toEqual({
      permissionProfile: 'default',
      wardenCwd: '/test/worktree',
      toolBrokerContext: {
        cwd: '/test/worktree',
        groupFolder: 'test-group',
        chatJid: 'test@example.invalid',
        isControlGroup: true,
      },
      allowedWebFetchHosts: ['example.com'],
    });
  });
});

describe('handleNestedDispatchToolCall: real profile coverage (default-unchanged)', () => {
  it('the real "default" profile allows web_search (matches production allow-all default)', async () => {
    const realAction = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const result = await handleNestedDispatchToolCall(
      validEncodedContext({ permissionProfile: 'default' }),
      'web_search',
      { query: 'x' },
      realAction,
    );
    expect(realAction).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
  });

  it('the real "read-only" profile allows web_fetch (matches lia449b spike precedent)', async () => {
    const realAction = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const result = await handleNestedDispatchToolCall(
      validEncodedContext({ permissionProfile: 'read-only' }),
      'web_fetch',
      { url: 'https://example.com' },
      realAction,
    );
    expect(realAction).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
  });

  it('an unknown profile name fails closed (never falls back to a weaker policy)', async () => {
    const realAction = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const result = await handleNestedDispatchToolCall(
      validEncodedContext({ permissionProfile: 'nonexistent-profile' }),
      'web_search',
      { query: 'x' },
      realAction,
    );
    expect(realAction).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});

describe('handleNestedDispatchToolCall: warden gate (structural parity)', () => {
  it('denies when selectWardenBehaviors returns a non-empty set, even under an allow permission decision', async () => {
    vi.resetModules();
    vi.doMock('../middleware-stack.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../middleware-stack.js')>();
      return {
        ...actual,
        selectWardenBehaviors: () => ['code-review-gate'],
      };
    });
    const { handleNestedDispatchToolCall: handleWithMockedWardens } =
      await import('./nested-dispatch-mcp-server.js');
    const realAction = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));

    const result = await handleWithMockedWardens(
      validEncodedContext({ permissionProfile: 'default' }),
      'web_search',
      { query: 'x' },
      realAction,
    );

    expect(realAction).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('warden-gated');
    vi.doUnmock('../middleware-stack.js');
    vi.resetModules();
  });
});

describe('createNestedDispatchMcpServer', () => {
  it('constructs an MCP server without starting any transport (no stdio connect)', () => {
    const server = createNestedDispatchMcpServer();
    expect(server).toBeDefined();
  });
});
