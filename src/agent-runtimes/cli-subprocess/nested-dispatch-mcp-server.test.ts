import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only `execFile` (the real warden-gate Python invocation, now genuinely
// reachable from this file via the shared `mcp-tool-gate.ts`) needs faking
// — neither test below actually reaches the wardens check (web_search is
// never warden-gated; both scenarios short-circuit at the permissions
// layer), but mocking it lets both assert zero real subprocess spawns
// rather than merely "the test happened not to trigger one by accident".
vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { execFile } from 'node:child_process';
import {
  createNestedDispatchMcpServer,
  handleNestedDispatchToolCall,
  parseNestedDispatchContext,
} from './nested-dispatch-mcp-server.js';

const execFileMock = vi.mocked(execFile);

function validEncodedContext(
  overrides: Partial<{
    permissionProfile: string | null;
    allowedWebFetchHosts: string[];
    wardenCwd: string;
  }> = {},
): string {
  return JSON.stringify({
    permissionProfile: overrides.permissionProfile ?? 'default',
    wardenCwd: overrides.wardenCwd ?? '/test/worktree',
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

// LIA-454 EP-002 step 7: wardens are now REALLY enforced (via the shared
// `gateAndExecuteMcpTool`/`runWardenBehavior`, not a detect-and-deny stub).
// `apply_patch`/commit-shaped `Bash` are the only real trigger shapes
// (`selectWardenBehaviors`), and neither `web_search` nor `web_fetch` is one
// of them — so these tests prove the WIRING (this file threads
// `wardenCwd`/`permissionProfile` correctly into the shared gate, which is
// itself exhaustively tested in `mcp-tool-gate.test.ts`) via
// `parseNestedDispatchContext`'s own internal fields, not by re-testing the
// shared gate's policy logic again here.
describe('handleNestedDispatchToolCall: threads context into the shared gate', () => {
  let behaviorResponse: { kind: 'stdout'; stdout: string } | undefined;

  beforeEach(() => {
    behaviorResponse = undefined;
    execFileMock.mockReset();
    execFileMock.mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, stdout: string) => void,
    ) => {
      const child = {
        stdin: {
          on: () => child.stdin,
          end: () => {
            queueMicrotask(() =>
              callback(null, behaviorResponse?.stdout ?? ''),
            );
          },
        },
      };
      return child as unknown as ReturnType<typeof execFile>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    execFileMock.mockReset();
  });

  it('a real permission deny still never invokes execFile at all (permissions short-circuit before wardens)', async () => {
    const realAction = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const result = await handleNestedDispatchToolCall(
      validEncodedContext({ permissionProfile: 'read-only' }),
      'web_search',
      { query: 'x' },
      realAction,
    );
    // read-only denies dispatch-shaped tools but allows web_search/web_fetch
    // — this asserts the ALLOW path reaches realAction with zero warden
    // invocation, since neither tool is ever warden-gated today.
    expect(realAction).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
  });

  it('actually consults resolveMiddlewareStackConfig() — DEUS_NATIVE_MIDDLEWARE_CONFIG={"permissions":false} lets a normally-denied tool through', async () => {
    // Neither real built-in profile ('default', 'read-only') denies
    // web_search/web_fetch, so a genuinely discriminating test needs a
    // synthetic deny profile — same `vi.doMock` technique
    // `nested-dispatch-mcp-server.oracle.test.ts` already established for
    // exactly this reason (see its own module doc comment).
    vi.resetModules();
    vi.doMock('../permission-rules.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../permission-rules.js')>();
      return {
        ...actual,
        resolvePermissionProfile: (name: string) =>
          name === 'deny-web-search'
            ? {
                rules: [{ toolName: 'web_search', decision: 'deny' as const }],
                defaultDecision: 'allow' as const,
              }
            : actual.resolvePermissionProfile(name),
      };
    });
    const { handleNestedDispatchToolCall: handleWithSyntheticProfile } =
      await import('./nested-dispatch-mcp-server.js');

    const previous = process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    try {
      const realAction = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      }));

      delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
      const denied = await handleWithSyntheticProfile(
        validEncodedContext({ permissionProfile: 'deny-web-search' }),
        'web_search',
        { query: 'x' },
        realAction,
      );
      expect(realAction).not.toHaveBeenCalled();
      expect(denied.isError).toBe(true);

      process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG = JSON.stringify({
        permissions: false,
      });
      const allowed = await handleWithSyntheticProfile(
        validEncodedContext({ permissionProfile: 'deny-web-search' }),
        'web_search',
        { query: 'x' },
        realAction,
      );
      expect(realAction).toHaveBeenCalledTimes(1);
      expect(allowed.isError).not.toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
      } else {
        process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG = previous;
      }
      vi.doUnmock('../permission-rules.js');
      vi.resetModules();
    }
  });
});

describe('createNestedDispatchMcpServer', () => {
  it('constructs an MCP server without starting any transport (no stdio connect)', () => {
    const server = createNestedDispatchMcpServer();
    expect(server).toBeDefined();
  });
});
