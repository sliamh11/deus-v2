/**
 * LIA-454 EP-002 step 8: parent-turn-mcp-server.ts tests.
 *
 * `handleParentTurnToolCall` is exported specifically to be directly
 * testable with injected fakes (no real MCP transport, no real subprocess,
 * no real filesystem) — same pattern `nested-dispatch-mcp-server.ts`'s own
 * `handleNestedDispatchToolCall` already established.
 */
import { describe, expect, it, vi } from 'vitest';

const agentSpecLoaderMocks = vi.hoisted(() => ({
  loadAgentSpecs: vi.fn(),
}));
vi.mock('../agent-spec-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../agent-spec-loader.js')>();
  return { ...actual, loadAgentSpecs: agentSpecLoaderMocks.loadAgentSpecs };
});

import {
  buildModelPolicy,
  createParentTurnMcpServer,
  handleParentTurnToolCall,
  loadFilteredAgentSpecsForParent,
  parseParentTurnContext,
  type ParentTurnMcpContext,
  type ParentTurnToolDeps,
} from './parent-turn-mcp-server.js';
import type { NestedDispatchResult } from '../nested-dispatch.js';
import type { LoadedAgentSpec } from '../agent-spec-loader.js';

function validEncodedContext(
  overrides: Partial<{
    permissionProfile: string | null;
    allowedWebFetchHosts: string[];
  }> = {},
): string {
  return JSON.stringify({
    permissionProfile: overrides.permissionProfile ?? 'default',
    wardenCwd: '/test/worktree',
    safeToolCwd: '/test/worktree',
    allowedWebFetchHosts: overrides.allowedWebFetchHosts ?? ['example.com'],
    parentSessionId: 'session-1',
    effectiveModels: {
      main: { provider: 'anthropic', model: 'claude-opus-4-8' },
      roles: {},
    },
    agentCatalogIds: [],
  });
}

describe('parseParentTurnContext', () => {
  it('returns undefined for undefined input', () => {
    expect(parseParentTurnContext(undefined)).toBeUndefined();
  });

  it('returns undefined for unparseable JSON', () => {
    expect(parseParentTurnContext('{not valid')).toBeUndefined();
  });

  it('returns undefined for valid JSON missing required fields', () => {
    expect(parseParentTurnContext(JSON.stringify({}))).toBeUndefined();
  });

  it('returns undefined when effectiveModels.main has an unknown provider (fails closed via validateNativeModelRef)', () => {
    const raw = JSON.parse(validEncodedContext());
    raw.effectiveModels.main = { provider: 'openai', model: 'gpt-4' };
    expect(parseParentTurnContext(JSON.stringify(raw))).toBeUndefined();
  });

  it('returns undefined when a role model ref is invalid, even if main is valid', () => {
    const raw = JSON.parse(validEncodedContext());
    raw.effectiveModels.roles = {
      reviewer: { provider: 'anthropic', model: 'not-a-real-model' },
    };
    expect(parseParentTurnContext(JSON.stringify(raw))).toBeUndefined();
  });

  it('parses a well-formed context, with validated model refs', () => {
    const context = parseParentTurnContext(validEncodedContext());
    expect(context).toEqual({
      permissionProfile: 'default',
      wardenCwd: '/test/worktree',
      safeToolCwd: '/test/worktree',
      allowedWebFetchHosts: ['example.com'],
      parentSessionId: 'session-1',
      effectiveModels: {
        main: { provider: 'anthropic', model: 'claude-opus-4-8' },
        roles: {},
      },
      agentCatalogIds: [],
    });
  });
});

const BASE_CONTEXT: ParentTurnMcpContext = {
  permissionProfile: 'default',
  wardenCwd: '/test/worktree',
  safeToolCwd: '/test/worktree',
  allowedWebFetchHosts: ['example.com'],
  parentSessionId: 'session-1',
  effectiveModels: {
    main: { provider: 'anthropic', model: 'claude-opus-4-8' },
    roles: {},
  },
  agentCatalogIds: [],
};

function fakeDeps(
  overrides: Partial<ParentTurnToolDeps> = {},
): ParentTurnToolDeps & {
  webActionCalls: string[];
  nestedDispatchCalls: number;
} {
  const webActionCalls: string[] = [];
  let nestedDispatchCalls = 0;
  return {
    context: BASE_CONTEXT,
    middlewareConfig: {},
    getWebAction: async (toolName) => {
      webActionCalls.push(toolName);
      return async () => ({
        content: [{ type: 'text', text: `${toolName}-result` }],
      });
    },
    getNestedDispatchDeps: () => {
      nestedDispatchCalls += 1;
      return {
        dispatcher: {
          dispatch: vi.fn(async (): Promise<NestedDispatchResult<unknown>> => ({
            status: 'success',
            output: { ok: true },
            metadata: { agentId: 'a', model: 'm' },
          })),
        },
        modelPolicy: { resolveEffectiveModelId: () => 'claude-opus-4-8' },
        agentSpecs: new Map(),
      };
    },
    webActionCalls,
    get nestedDispatchCalls() {
      return nestedDispatchCalls;
    },
    ...overrides,
  } as ParentTurnToolDeps & {
    webActionCalls: string[];
    nestedDispatchCalls: number;
  };
}

describe('handleParentTurnToolCall: missing/malformed context fails closed for ALL three tools', () => {
  it.each(['web_search', 'web_fetch', 'dispatch_nested_agent'] as const)(
    '%s is denied when context is undefined, never calling any dep',
    async (toolName) => {
      const getWebAction = vi.fn();
      const getNestedDispatchDeps = vi.fn();
      const result = await handleParentTurnToolCall(
        toolName,
        {},
        {
          context: undefined,
          middlewareConfig: {},
          getWebAction,
          getNestedDispatchDeps,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('DEUS_PARENT_TURN_CONTEXT');
      expect(getWebAction).not.toHaveBeenCalled();
      expect(getNestedDispatchDeps).not.toHaveBeenCalled();
    },
  );
});

describe('handleParentTurnToolCall: policy enforcement', () => {
  it('fails closed on an unknown permission profile for any tool', async () => {
    const deps = fakeDeps({
      context: { ...BASE_CONTEXT, permissionProfile: 'does-not-exist' },
    });
    const result = await handleParentTurnToolCall(
      'web_search',
      { query: 'x' },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'permission profile resolution failed',
    );
    expect(deps.webActionCalls).toEqual([]);
  });

  it('read-only denies dispatch_nested_agent BEFORE any nested-dispatch dep is ever touched (no child creation)', async () => {
    const deps = fakeDeps({
      context: { ...BASE_CONTEXT, permissionProfile: 'read-only' },
    });
    const result = await handleParentTurnToolCall(
      'dispatch_nested_agent',
      {
        agentId: 'a',
        model: 'm',
        prompt: 'x',
        outputContract: { name: 'n', schema: {} },
      },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('permission_denied');
    expect(deps.nestedDispatchCalls).toBe(0);
  });

  it("read-only ALLOWS web_search/web_fetch (matches the child server's own read-only allowance)", async () => {
    const deps = fakeDeps({
      context: { ...BASE_CONTEXT, permissionProfile: 'read-only' },
    });
    const searchResult = await handleParentTurnToolCall(
      'web_search',
      { query: 'x' },
      deps,
    );
    const fetchResult = await handleParentTurnToolCall(
      'web_fetch',
      { url: 'https://x' },
      deps,
    );
    expect(searchResult.isError).toBeUndefined();
    expect(fetchResult.isError).toBeUndefined();
    expect(deps.webActionCalls).toEqual(['web_search', 'web_fetch']);
  });

  it('permissions:false skips permission enforcement for dispatch_nested_agent too', async () => {
    const deps = fakeDeps({
      context: { ...BASE_CONTEXT, permissionProfile: 'read-only' },
      middlewareConfig: { permissions: false },
    });
    const result = await handleParentTurnToolCall(
      'dispatch_nested_agent',
      {
        agentId: 'a',
        model: 'm',
        prompt: 'x',
        outputContract: { name: 'n', schema: {} },
      },
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(deps.nestedDispatchCalls).toBe(1);
  });
});

describe('handleParentTurnToolCall: real-action single invocation', () => {
  it('web_search invokes its action exactly once and returns its content', async () => {
    const deps = fakeDeps();
    const result = await handleParentTurnToolCall(
      'web_search',
      { query: 'x' },
      deps,
    );
    expect(deps.webActionCalls).toEqual(['web_search']);
    expect(result.content[0].text).toBe('web_search-result');
  });

  it('dispatch_nested_agent invokes the nested-dispatch deps factory exactly once', async () => {
    const deps = fakeDeps();
    const result = await handleParentTurnToolCall(
      'dispatch_nested_agent',
      {
        agentId: 'a',
        model: 'm',
        prompt: 'do it',
        outputContract: { name: 'n', schema: { type: 'object' } },
      },
      deps,
    );
    expect(deps.nestedDispatchCalls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('<nested-dispatch-output');
  });
});

describe('handleParentTurnToolCall: nested model policy', () => {
  it('threads the injected modelPolicy through to the actual dispatched request', async () => {
    let capturedModel: string | undefined;
    const deps = fakeDeps({
      getNestedDispatchDeps: () => ({
        dispatcher: {
          dispatch: async <T>(request: {
            model: string;
          }): Promise<NestedDispatchResult<T>> => {
            capturedModel = request.model;
            return {
              status: 'success',
              output: { ok: true } as T,
              metadata: { agentId: 'a', model: request.model },
            };
          },
        },
        modelPolicy: { resolveEffectiveModelId: () => 'claude-sonnet-4-6' },
        agentSpecs: new Map(),
      }),
    });
    await handleParentTurnToolCall(
      'dispatch_nested_agent',
      {
        agentId: 'a',
        model: 'ignored-caller-model',
        prompt: 'do it',
        outputContract: { name: 'n', schema: { type: 'object' } },
      },
      deps,
    );
    expect(capturedModel).toBe('claude-sonnet-4-6');
  });
});

describe('createParentTurnMcpServer', () => {
  it('constructs an MCP server without starting any transport (no stdio connect)', () => {
    const { server, shutdown } = createParentTurnMcpServer();
    expect(server).toBeDefined();
    expect(typeof shutdown).toBe('function');
  });

  it('shutdown() resolves cleanly even when no nested pool was ever constructed', async () => {
    const { shutdown } = createParentTurnMcpServer();
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('registers exactly the three-tool catalog (web_search, web_fetch, dispatch_nested_agent) — no more, no fewer', () => {
    const { server } = createParentTurnMcpServer();
    // `_registeredTools` is a private SDK field with no public listing
    // accessor — reached here for test introspection only (code-review
    // finding: the plan's own step-8 acceptance criterion is "exact
    // three-tool catalog", which no prior test directly asserted).
    const registeredNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools,
    ).sort();
    expect(registeredNames).toEqual(
      ['dispatch_nested_agent', 'web_fetch', 'web_search'].sort(),
    );
  });
});

describe('buildModelPolicy', () => {
  const specWithModel: LoadedAgentSpec = {
    name: 'reviewer',
    description: 'a role',
    model: 'checked-in-alias',
    systemPrompt: 'You review things.',
    sourcePath: '/fake/reviewer.md',
    frontmatter: { description: 'a role' },
  };

  it("explicit user role config wins first, even over the role's own checked-in model", () => {
    const context: ParentTurnMcpContext = {
      ...BASE_CONTEXT,
      effectiveModels: {
        main: { provider: 'anthropic', model: 'claude-opus-4-8' },
        roles: {
          reviewer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        },
      },
    };
    const policy = buildModelPolicy(
      context,
      new Map([['reviewer', specWithModel]]),
    );
    expect(policy.resolveEffectiveModelId('reviewer', 'whatever')).toBe(
      'claude-sonnet-4-6',
    );
  });

  it("falls back to the role's own checked-in frontmatter model (via resolveWardenModelAlias) when no explicit role config exists", () => {
    const specWithRealAlias: LoadedAgentSpec = {
      ...specWithModel,
      model: 'sonnet', // a real, resolvable warden alias
    };
    const policy = buildModelPolicy(
      BASE_CONTEXT,
      new Map([['reviewer', specWithRealAlias]]),
    );
    const resolved = policy.resolveEffectiveModelId('reviewer', 'whatever');
    expect(resolved).not.toBe('whatever');
    expect(typeof resolved).toBe('string');
  });

  it('falls back to the configured main model when neither explicit role config nor a resolvable spec alias exists', () => {
    const policy = buildModelPolicy(BASE_CONTEXT, new Map());
    expect(policy.resolveEffectiveModelId('unknown-agent', 'whatever')).toBe(
      'claude-opus-4-8',
    );
  });
});

describe('loadFilteredAgentSpecsForParent', () => {
  it('filters the loaded catalog down to exactly the allowlisted ids, never widening it', () => {
    const allSpecs = new Map<string, LoadedAgentSpec>([
      ['reviewer', { ...specForTest('reviewer') }],
      ['unrelated-role', { ...specForTest('unrelated-role') }],
    ]);
    agentSpecLoaderMocks.loadAgentSpecs.mockReturnValue(allSpecs);
    const filtered = loadFilteredAgentSpecsForParent([
      'reviewer',
      'not-in-catalog',
    ]);
    expect([...filtered.keys()]).toEqual(['reviewer']);
  });

  it('fails OPEN to an empty catalog when loadAgentSpecs() throws (a malformed unrelated spec must not block dispatch capability entirely)', () => {
    agentSpecLoaderMocks.loadAgentSpecs.mockImplementation(() => {
      throw new Error('Invalid agent specifications');
    });
    const filtered = loadFilteredAgentSpecsForParent(['reviewer']);
    expect(filtered.size).toBe(0);
  });

  function specForTest(name: string): LoadedAgentSpec {
    return {
      name,
      description: 'test',
      systemPrompt: 'test',
      sourcePath: `/fake/${name}.md`,
      frontmatter: { description: 'test' },
    };
  }
});
