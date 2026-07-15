import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ContainerRuntimeDeps } from './container-backend.js';
import type { RuntimeEvent } from './types.js';

// Hoisted mocks — no live network call, no live model call anywhere in this
// file, matching every other spike/adapter test's hermeticity convention.
const { createAgentMock, invokeMock } = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return {
    // Keep the real module (middleware-stack.ts needs the real
    // createMiddleware — pure construction, no network) and stub only the
    // agent factory, which is what would otherwise hit the model.
    ...actual,
    createAgent: createAgentMock,
  };
});

class FakeChatAnthropic {
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
}
vi.mock('@langchain/anthropic', () => ({
  // Constructor-only stub — never makes a network call, just records the
  // config it was built with so a test can assert on it if needed.
  ChatAnthropic: FakeChatAnthropic,
}));

class FakeAnthropicClient {
  config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
}
vi.mock('@anthropic-ai/sdk', () => ({
  default: FakeAnthropicClient,
}));

const detectAuthModeMock = vi.fn(() => 'api-key' as 'api-key' | 'oauth');
vi.mock('../credential-proxy.js', () => ({
  detectAuthMode: () => detectAuthModeMock(),
}));

const getOrCreateGroupTokenMock = vi.fn(
  (_folder?: string) => 'fake-proxy-token',
);
vi.mock('../group-tokens.js', () => ({
  getOrCreateGroupToken: (folder?: string) => getOrCreateGroupTokenMock(folder),
}));

// buildSafeTools is exercised directly by the oracle test — here it's
// enough to know runTurn calls it and passes the result to createAgent.
vi.mock('./tool-broker-langchain-adapter.js', () => ({
  buildSafeTools: vi.fn(() => []),
}));

const { createDeusNativeRuntime } = await import('./deus-native-backend.js');

const stubDeps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => {},
};

describe('DeusNativeBackend', () => {
  const backend = createDeusNativeRuntime(stubDeps);

  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    // .mockReset() (not just .mockReturnValue()) so both call history AND any
    // .mockImplementation() override from a prior test (e.g. the token-mint-
    // failure test below) don't leak into the next test's assertions -- a
    // gap this file had until a new .not.toHaveBeenCalled() assertion
    // surfaced it.
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
  });

  it('returns correct name', () => {
    expect(backend.name()).toBe('deus-native');
  });

  it('returns correct capabilities', () => {
    const caps = backend.capabilities();
    // Security boundary — see docs/decisions/deus-v2-langchain-runtime.md.
    expect(caps.shell).toBe(false);
    expect(caps.filesystem).toBe(false);
    expect(caps.web).toBe(true);
    expect(caps.multimodal).toBe(false);
    expect(caps.handoffs).toBe(false);
    // B4 (checkpointer-to-sessions-table) hasn't landed yet.
    expect(caps.persistent_sessions).toBe(false);
    expect(caps.tool_streaming).toBe(false);
  });

  it('startOrResume returns default session ref', async () => {
    const ref = await backend.startOrResume({
      prompt: 'test',
      groupFolder: 'test-folder',
      chatJid: 'test@g.us',
      isControlGroup: false,
    });

    expect(ref.backend).toBe('deus-native');
    expect(ref.session_id).toBe('');
  });

  it('close resolves without error', async () => {
    await expect(
      backend.close({ backend: 'deus-native', session_id: 'deus-native-abc' }),
    ).resolves.toBeUndefined();
  });

  it('runTurn returns error when the proxy token mint fails (analogous to "group not found")', async () => {
    getOrCreateGroupTokenMock.mockImplementation(() => {
      throw new Error(
        'getOrCreateGroupToken: folder is a publicIngress folder',
      );
    });

    const events: RuntimeEvent[] = [];
    const result = await backend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'nonexistent',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('publicIngress');
    // Never throws out of runTurn — matches ContainerRuntime.runTurn's
    // never-throw contract. No terminal success events were emitted.
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('runTurn refuses a publicIngress group before minting a token or building a model (fail-closed guard, added after code-review)', async () => {
    // Mirrors buildContainerArgs's own fail-closed check (container-runner.ts)
    // for the container path -- deus-native never calls that function, so
    // this is its own independent enforcement of the same rule: a
    // publicIngress (webhook-originated) group must never reach a non-Claude
    // backend's unscoped tool surface.
    const publicIngressDeps: ContainerRuntimeDeps = {
      resolveGroup: () => ({
        name: 'webhook group',
        folder: 'webhook-folder',
        trigger: 'auto',
        added_at: new Date().toISOString(),
        containerConfig: { publicIngress: true },
      }),
      assistantName: 'Deus',
      registerProcess: () => {},
    };
    const publicIngressBackend = createDeusNativeRuntime(publicIngressDeps);

    const result = await publicIngressBackend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'webhook-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('publicIngress');
    expect(result.error).toContain('deus-native');
    // The guard must fire BEFORE any token mint or model construction --
    // never a "fail after doing the unsafe thing" check.
    expect(getOrCreateGroupTokenMock).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('runTurn returns error when detectAuthMode / createAgent throws', async () => {
    createAgentMock.mockImplementation(() => {
      throw new Error('simulated createAgent failure');
    });

    const result = await backend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );

    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('simulated createAgent failure');
  });

  it('runTurn maps a scripted createAgent response into the RunResult contract and emits the expected RuntimeEvent sequence', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockResolvedValue({
      messages: [
        { content: 'search the web for X' },
        {
          content: '',
          tool_calls: [{ name: 'web_search', args: { query: 'X' } }],
        },
        { content: 'Here is what I found about X.' },
      ],
    });

    const events: RuntimeEvent[] = [];
    const result = await backend.runTurn(
      {
        prompt: 'find X',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );

    // Contract shape (RunResult).
    expect(result.status).toBe('success');
    expect(result.result).toBe('Here is what I found about X.');

    // Event sequence: the intermediate tool_call, then output_text, then
    // turn_complete — matching RuntimeEvent's union.
    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      type: 'tool_call',
      name: 'web_search',
      arguments: { query: 'X' },
    });

    const outputTextEvents = events.filter((e) => e.type === 'output_text');
    expect(outputTextEvents).toHaveLength(1);
    expect(outputTextEvents[0]).toMatchObject({
      type: 'output_text',
      text: 'Here is what I found about X.',
    });

    expect(events.some((e) => e.type === 'turn_complete')).toBe(true);

    // Bare prompt only — no CLAUDE.md/AGENTS.md/persona context, per the
    // plan's explicit non-goal.
    expect(invokeMock).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'find X' }],
    });

    // OAuth-vs-API-key branching happened via detectAuthMode, and a
    // per-group token was minted.
    expect(getOrCreateGroupTokenMock).toHaveBeenCalledWith('test-folder');

    // B2 (LIA-402): runTurn wires the middleware stack into createAgent in
    // canonical order — all four layers enabled by default (AC1 at the
    // runtime level; composition semantics are proven in
    // middleware-stack.test.ts's AC4 ordering test). B3 (LIA-403) appends
    // its prompt-lifecycle middleware LAST — appended, never prepended, so
    // B2's AC1-locked order is untouched.
    const createAgentArgs = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string }>;
    };
    expect(createAgentArgs.middleware?.map((m) => m.name)).toEqual([
      'permissions',
      'wardens',
      'memory',
      'telemetry',
      'prompt-lifecycle',
    ]);
  });

  it('branches to OAuth-mode client construction when detectAuthMode() returns "oauth"', async () => {
    detectAuthModeMock.mockReturnValue('oauth');
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockResolvedValue({
      messages: [{ content: 'ok' }],
    });

    const result = await backend.runTurn(
      {
        prompt: 'hello',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );

    expect(result.status).toBe('success');
    expect(detectAuthModeMock).toHaveBeenCalled();
  });
});
