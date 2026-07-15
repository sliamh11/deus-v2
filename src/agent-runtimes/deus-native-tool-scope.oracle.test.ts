/**
 * Oracle tests for LIA-401/B1 — the deus-native AgentRuntime adapter's tool-scope
 * security boundary.
 *
 * @oracle Independently authored from the plan's Decision section (LIA-401/B1),
 * BLIND to the implementation — tool-broker-langchain-adapter.ts and
 * deus-native-backend.ts do not exist yet at authoring time. Must not be
 * weakened by the implementer; strengthen instead of loosen if a real gap
 * is found during implementation.
 *
 * SPEC (verbatim intent, from the plan's Decision section):
 *   - container/agent-runner/src/tool-broker.ts has no OS-level sandboxing
 *     primitive to fall back on. The container process is the only sandbox.
 *   - B1 ships a conservative tool surface: ONLY web_search and web_fetch are
 *     ever wired into the deus-native adapter. bash_exec/read_file/write_file/
 *     edit_file/glob_files/grep_files are explicitly NOT wired.
 *   - This is an INCLUSION filter, not an exclusion list of six names — every
 *     other broker tool, present or future (agent_browser, send_message,
 *     schedule_task, list_tasks, pause_task, resume_task, cancel_task,
 *     update_task, register_group, and anything added later) must never be
 *     reachable through this adapter.
 *   - web_fetch must be host-allowlisted via withHostAllowlist: a code-level
 *     URL-hostname check that runs BEFORE the wrapped tool executes. Empty
 *     allowlist = deny all fetches. Disallowed/malformed URLs return a
 *     structured JSON error string and the wrapped tool is never invoked.
 *   - capabilities().shell === false and capabilities().filesystem === false
 *     is the adapter's stated security posture; name() === 'deus-native'.
 *
 * These tests are RED against the current tree (the two source modules do not
 * exist — this file will fail to even resolve its imports) and must go GREEN
 * once the implementer adds:
 *   - src/agent-runtimes/tool-broker-langchain-adapter.ts
 *       exporting toolBrokerToLangChainTools, withHostAllowlist, buildSafeTools
 *   - src/agent-runtimes/deus-native-backend.ts
 *       exporting createDeusNativeRuntime
 * per the signatures agreed in the plan (no other public surface is assumed).
 *
 * HERMETIC: this file makes no real network calls. 'http'/'https' `request`,
 * 'dns/promises' `lookup`, and the global `fetch` are all replaced with
 * spies for the duration of this file, so even a buggy fail-open
 * implementation cannot escape to a real socket — it will just show up as a
 * spy call in the assertions below instead of a live connection attempt.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { getOpenAIToolDefinitions } from '../../container/agent-runner/src/tool-broker.js';
import type { ToolBrokerContext } from '../../container/agent-runner/src/tool-broker.js';
import type { ContainerRuntimeDeps } from './container-backend.js';

// These two modules do not exist yet — that is the point (see file header).
// vi.mock calls below are hoisted by vitest above ALL imports in this file
// (static or otherwise), so the network guards are in place before this
// import (or its transitive tool-broker.ts import) ever executes.
import {
  buildSafeTools,
  withHostAllowlist,
} from './tool-broker-langchain-adapter.js';
import { createDeusNativeRuntime } from './deus-native-backend.js';

// ---------------------------------------------------------------------------
// Hermetic network guards — must be declared before importing the modules
// under test, since those imports may transitively pull in tool-broker.ts
// (which performs real 'http'/'https'/'dns' I/O for web_fetch/web_search).
// ---------------------------------------------------------------------------

const { httpRequestSpy, httpsRequestSpy, dnsLookupSpy, fetchSpy } = vi.hoisted(
  () => ({
    httpRequestSpy: vi.fn(),
    httpsRequestSpy: vi.fn(),
    dnsLookupSpy: vi.fn(),
    fetchSpy: vi.fn(async () => {
      throw new Error(
        'ORACLE: global fetch() was invoked — the reject path must return before any network I/O',
      );
    }),
  }),
);

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return { ...actual, request: httpRequestSpy };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return { ...actual, request: httpsRequestSpy };
});

vi.mock('dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dns/promises')>();
  return {
    ...actual,
    lookup: dnsLookupSpy,
    default: { ...actual, lookup: dnsLookupSpy },
  };
});

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchSpy);
afterAll(() => {
  vi.unstubAllGlobals();
  if (realFetch) globalThis.fetch = realFetch;
});

beforeEach(() => {
  httpRequestSpy.mockClear();
  httpsRequestSpy.mockClear();
  dnsLookupSpy.mockClear();
  fetchSpy.mockClear();
});

function expectNoNetworkIO(): void {
  // @oracle: reject path must return before ANY network primitive is touched
  expect(httpRequestSpy).not.toHaveBeenCalled();
  expect(httpsRequestSpy).not.toHaveBeenCalled();
  expect(dnsLookupSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

function makeCtx(): ToolBrokerContext {
  return {
    cwd: '/workspace/group',
    containerInput: {
      groupFolder: 'oracle-test-group',
      chatJid: 'oracle-test@s.whatsapp.net',
      isMain: false,
      isControlGroup: false,
    },
  };
}

// ===========================================================================
// 1) buildSafeTools() returns EXACTLY {web_search, web_fetch} — no more, no fewer
// ===========================================================================

describe('deus-native tool scope — oracle: exact safe-tool set', () => {
  it('buildSafeTools() returns exactly web_search and web_fetch, nothing else', async () => {
    // @oracle: plan Decision — "B1 ships with a conservative tool surface... web_search/web_fetch"
    // buildSafeTools is now async (fixed after code-review round 1: the lazy
    // tool-broker import replaced an eager top-level await that could crash
    // the whole process at boot) -- mechanical adaptation, assertions unchanged.
    const tools = await buildSafeTools(makeCtx(), []);
    const names = tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['web_fetch', 'web_search']);
    // No duplicates, no extras hiding behind aliasing
    expect(tools).toHaveLength(2);
  });
});

// ===========================================================================
// 2) Inclusion-filter property: EVERY other live broker tool name must be
//    absent, derived from getOpenAIToolDefinitions() at runtime — not a
//    hardcoded six-name exclusion list. This is what survives future broker
//    tool additions.
// ===========================================================================

describe('deus-native tool scope — oracle: inclusion filter survives broker growth', () => {
  const allToolNames = getOpenAIToolDefinitions().map((d) => d.name);
  const nonSafeNames = allToolNames.filter(
    (n) => n !== 'web_search' && n !== 'web_fetch',
  );

  it('sanity: the live broker currently defines far more than web_search/web_fetch', () => {
    // @oracle: guards against a vacuous inclusion-filter test if the broker ever shrinks to just these 2
    expect(nonSafeNames.length).toBeGreaterThan(0);
    // Canary of the tools named explicitly in the plan's Decision section, confirmed
    // present in container/agent-runner/src/tool-broker.ts at authoring time. This
    // pins the CURRENT reality; the loop below is what protects the FUTURE.
    expect(nonSafeNames).toEqual(
      expect.arrayContaining([
        'bash_exec',
        'read_file',
        'write_file',
        'edit_file',
        'glob_files',
        'grep_files',
        'agent_browser',
        'send_message',
        'schedule_task',
        'list_tasks',
        'pause_task',
        'resume_task',
        'cancel_task',
        'update_task',
        'register_group',
      ]),
    );
  });

  it('every non-safe broker tool name is absent from buildSafeTools() output', async () => {
    // @oracle: plan Decision — "must never be reachable" for any tool other than web_search/web_fetch,
    // "present or future". Derived from the live broker list, not hardcoded, so a NEW
    // broker tool added later is caught automatically without editing this test.
    const tools = await buildSafeTools(makeCtx(), []);
    const safeNames = new Set(tools.map((t: { name: string }) => t.name));
    for (const name of nonSafeNames) {
      expect(safeNames.has(name)).toBe(false);
    }
  });
});

// ===========================================================================
// 3) buildSafeTools()'s web_fetch rejects disallowed/malformed URLs with a
//    structured JSON error and NEVER touches the network to do so.
// ===========================================================================

describe('deus-native tool scope — oracle: web_fetch host-allowlist reject path', () => {
  async function getWebFetchTool(allowedHosts: string[]) {
    const tools = await buildSafeTools(makeCtx(), allowedHosts);
    const webFetch = tools.find(
      (t: { name: string }) => t.name === 'web_fetch',
    );
    if (!webFetch)
      throw new Error('web_fetch tool missing from buildSafeTools() output');
    return webFetch;
  }

  function expectStructuredErrorString(result: unknown): void {
    // @oracle: plan Decision — "returns a structured JSON error string to the model"
    expect(typeof result).toBe('string');
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(result as string);
    }).not.toThrow();
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
    expect(typeof (parsed as Record<string, unknown>).error).toBe('string');
    expect(
      ((parsed as Record<string, unknown>).error as string).length,
    ).toBeGreaterThan(0);
  }

  it('empty allowlist denies ANY url, even a well-formed public one', async () => {
    // @oracle: plan Decision — "empty array = deny all fetches"
    const webFetch = await getWebFetchTool([]);
    const result = await webFetch.invoke({ url: 'https://example.com/' });
    expectStructuredErrorString(result);
    expectNoNetworkIO();
  });

  it('non-empty allowlist denies a DISALLOWED host', async () => {
    // @oracle: plan Decision — code-level URL-hostname allowlist, checked before the wrapped tool runs
    const webFetch = await getWebFetchTool(['good.example.com']);
    const result = await webFetch.invoke({
      url: 'https://evil.example.com/steal',
    });
    expectStructuredErrorString(result);
    expectNoNetworkIO();
  });

  it.each([
    ['no scheme / spaces', 'not a url'],
    ['empty string', ''],
    ['missing colon after scheme', 'http//broken.example.com'],
    ['whitespace only', '   '],
  ])(
    'malformed URL (%s) is rejected WITHOUT throwing',
    async (_label, malformedUrl) => {
      // @oracle: plan Decision — "malformed URLs are rejected without throwing"
      const webFetch = await getWebFetchTool(['good.example.com']);
      // If the implementation lets a parse exception escape, this await itself throws
      // and the test fails — that IS the falsification for this requirement.
      const result = await webFetch.invoke({ url: malformedUrl });
      expectStructuredErrorString(result);
      expectNoNetworkIO();
    },
  );
});

// ===========================================================================
// 3b) withHostAllowlist() in isolation: direct proof it never invokes the
//     wrapped tool on a disallowed/malformed URL, independent of whatever
//     web_fetch's own internals turn out to be.
// ===========================================================================

describe('deus-native tool scope — oracle: withHostAllowlist decorator contract', () => {
  function makeFakeWrappedTool() {
    const wrappedFn = vi.fn(
      async (_input: { url: string }) => 'WRAPPED-TOOL-EXECUTED',
    );
    const fakeTool = tool(wrappedFn, {
      name: 'fake_web_fetch',
      description: 'oracle test double for the wrapped tool',
      schema: z.object({ url: z.string() }),
    });
    return { fakeTool, wrappedFn };
  }

  it('disallowed host: wrapped tool function is NEVER called', async () => {
    // @oracle: interface contract — "provably never invokes the wrapped tool"
    const { fakeTool, wrappedFn } = makeFakeWrappedTool();
    const guarded = withHostAllowlist(fakeTool, ['good.example.com']);
    const result = await guarded.invoke({ url: 'https://evil.example.com/' });
    expect(wrappedFn).not.toHaveBeenCalled();
    expect(typeof result).toBe('string');
    expect(result).not.toContain('WRAPPED-TOOL-EXECUTED');
  });

  it('empty allowlist: wrapped tool function is NEVER called for any host', async () => {
    // @oracle: interface contract — empty allowedHosts denies unconditionally
    const { fakeTool, wrappedFn } = makeFakeWrappedTool();
    const guarded = withHostAllowlist(fakeTool, []);
    await guarded.invoke({ url: 'https://anything-at-all.example.com/' });
    expect(wrappedFn).not.toHaveBeenCalled();
  });

  it('malformed URL: wrapped tool function is NEVER called and no exception escapes', async () => {
    // @oracle: interface contract — malformed input rejected before the wrapped tool runs
    const { fakeTool, wrappedFn } = makeFakeWrappedTool();
    const guarded = withHostAllowlist(fakeTool, ['good.example.com']);
    await expect(guarded.invoke({ url: 'not a url' })).resolves.toBeTypeOf(
      'string',
    );
    expect(wrappedFn).not.toHaveBeenCalled();
  });

  it('allowed host DOES invoke the wrapped tool — the guard is not fail-closed on everything', async () => {
    // @oracle: falsifies an over-broad guard that blocks even legitimate allowed hosts
    // (a stub that always denies would wrongly pass every test above but fail this one)
    const { fakeTool, wrappedFn } = makeFakeWrappedTool();
    const guarded = withHostAllowlist(fakeTool, ['good.example.com']);
    await guarded.invoke({ url: 'https://good.example.com/page' });
    expect(wrappedFn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 4) createDeusNativeRuntime() capabilities and identity
// ===========================================================================

describe('deus-native tool scope — oracle: runtime identity and declared capabilities', () => {
  const stubDeps: ContainerRuntimeDeps = {
    resolveGroup: () => undefined,
    assistantName: 'Deus',
    registerProcess: () => {},
  };

  it("name() returns 'deus-native'", () => {
    // @oracle: plan Decision — adapter identity
    const runtime = createDeusNativeRuntime(stubDeps);
    expect(runtime.name()).toBe('deus-native');
  });

  it('capabilities().shell is false', () => {
    // @oracle: plan Decision — "stated explicitly in the adapter's capabilities() flags (shell: false...)"
    const runtime = createDeusNativeRuntime(stubDeps);
    expect(runtime.capabilities().shell).toBe(false);
  });

  it('capabilities().filesystem is false', () => {
    // @oracle: plan Decision — "...filesystem: false) ... IS the entire security boundary for this adapter"
    const runtime = createDeusNativeRuntime(stubDeps);
    expect(runtime.capabilities().filesystem).toBe(false);
  });
});
