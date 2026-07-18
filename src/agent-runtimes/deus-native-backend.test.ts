import { execFile } from 'node:child_process';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ContainerRuntimeDeps } from './container-backend.js';
import type { RuntimeEvent } from './types.js';
import {
  RuntimeActivityBroadcaster,
  withRuntimeActivityBroadcast,
  type RuntimeActivityEnvelope,
} from './activity-broadcaster.js';

// Hoisted mocks — no live network call, no live model call anywhere in this
// file, matching every other spike/adapter test's hermeticity convention.
// checkpointerStub: a minimal fake BaseCheckpointSaver surface (getTuple is
// the only method runTurn itself calls; the rest of the saver is only ever
// exercised through the REAL LangGraph engine, which this file mocks away
// via createAgentMock). A single hoisted instance so the createAgent-wiring
// assertion below can prove the EXACT object was passed through.
const {
  createAgentMock,
  invokeMock,
  checkpointerStub,
  buildMiddlewareStackSpy,
  buildNestedDispatchToolMock,
  appendTranscriptMock,
  loadAgentSpecsSpy,
} = vi.hoisted(() => ({
  createAgentMock: vi.fn(),
  invokeMock: vi.fn(),
  checkpointerStub: { getTuple: async () => undefined },
  // D1 (LIA-415): a pass-through SPY (implementation assigned in the
  // module mock below — always the REAL buildMiddlewareStack), so tests
  // can inspect the deps runTurn supplies (memoryRequest presence/shape)
  // without changing any behavior. Use mockClear() only, never
  // mockReset() — reset would drop the real implementation.
  buildMiddlewareStackSpy: vi.fn(),
  // C1 (LIA-409): a stub (never delegates to the real nested-dispatch
  // machinery — no live dispatcher needed for any test in this file) that
  // records the CreateNestedDispatcherDeps runTurn supplies, so a test can
  // call `buildChildMiddleware()` directly and inspect the REAL wardens
  // middleware it returns, proving `wardenCwd` reaches nested-dispatch
  // children too.
  buildNestedDispatchToolMock: vi.fn((_deps?: unknown, _options?: unknown) => ({
    name: 'dispatch_nested_agent',
  })),
  appendTranscriptMock: vi.fn(),
  // LIA-444: a pass-through SPY over the REAL loadAgentSpecs (assigned in
  // the module mock below) — every test gets the genuine `.claude/agents/`
  // read (same convention as `buildMiddlewareStackSpy` and the unmocked
  // `warden-role-models.js`), except the one dedicated resilience test that
  // overrides it with `.mockImplementationOnce(() => { throw ... })` to
  // prove a malformed unrelated role spec doesn't crash the constructor.
  loadAgentSpecsSpy: vi.fn(),
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

// B4 (LIA-404): runTurn now unconditionally calls getCheckpointer() (both
// for the pre-invoke getTuple read and the createAgent wiring) — without
// this stub, EVERY runTurn call in this file would touch (or throw on) real
// filesystem state, since SqliteSaver.fromConnString opens its file eagerly
// and store/ doesn't exist on a clean checkout. A simple stub is sufficient
// here (getTuple -> undefined = "always a new session", today's behavior);
// the dedicated integration test file is where REAL checkpointer behavior
// is exercised.
vi.mock('./checkpointer.js', () => ({
  getCheckpointer: () => checkpointerStub,
}));

// D1 (LIA-415): keep the real module (real createMiddleware-built layers,
// real config parsing) and swap ONLY buildMiddlewareStack for a delegating
// spy — production behavior is unchanged, but the deps runTurn passes
// (memoryRequest for control-group turns) become inspectable.
vi.mock('./middleware-stack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./middleware-stack.js')>();
  buildMiddlewareStackSpy.mockImplementation(actual.buildMiddlewareStack);
  return { ...actual, buildMiddlewareStack: buildMiddlewareStackSpy };
});

// C1 (LIA-409): the real `wardens` middleware built inside `runTurn` resolves
// its repo root via a REAL `git rev-parse --git-common-dir` call (left
// unmocked here — this worktree genuinely is a linked worktree, so the real
// call is fast, deterministic, and exercises the actual production
// behavior). Only `execFile` (the Python gate subprocess) is replaced with a
// controllable fake — no test in this file exercises a real `apply_patch`/
// commit-shaped-`Bash` wardens trigger except the dedicated test below,
// which sets its own implementation.
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

// C1 (LIA-409): stub out the real nested-dispatch tool builder (see the
// hoisted `buildNestedDispatchToolMock` above) — no test in this file needs
// a live dispatcher, only the `CreateNestedDispatcherDeps` runTurn supplies
// it with.
vi.mock('./nested-dispatch-tool.js', () => ({
  buildNestedDispatchTool: buildNestedDispatchToolMock,
}));

// LIA-444: keep the real module (genuine .claude/agents/*.md reads, same
// convention as buildMiddlewareStackSpy above) and swap ONLY loadAgentSpecs
// for a delegating spy, so the one resilience test can override it for a
// single call without affecting any other test in this file.
vi.mock('./agent-spec-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./agent-spec-loader.js')>();
  loadAgentSpecsSpy.mockImplementation(actual.loadAgentSpecs);
  return { ...actual, loadAgentSpecs: loadAgentSpecsSpy };
});

vi.mock('./transcript-store.js', () => ({
  appendDeusNativeTranscriptTurn: appendTranscriptMock,
}));

const { createDeusNativeRuntime } = await import('./deus-native-backend.js');

const stubDeps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => {},
};

beforeEach(() => {
  appendTranscriptMock.mockReset();
  appendTranscriptMock.mockResolvedValue({
    ok: true,
    path: '/test/store/transcripts/deus-native/session.jsonl',
  });
});

// D5 (LIA-419): production now invokes the agent with a single HumanMessage
// carrying a per-turn stable `id` (`currentTurnMessageId` in
// deus-native-backend.ts) and locates that SAME id in the returned final
// state to scope this turn's messages (`currentTurnStart`) — required once
// compaction can make the final state SHORTER than the pre-turn state, so a
// prior-message-count slice is no longer valid. Real LangGraph echoes the
// input message back in the final checkpoint state; every invokeMock fixture
// in this file must do the same, or the runTurn under test throws
// FatalError('current turn input was missing from final agent state').
function invokeMockEcho(...trailingMessages: unknown[]) {
  invokeMock.mockImplementation(
    async (input: { messages: Array<{ id?: string }> }) => ({
      messages: [input.messages[0], ...trailingMessages],
    }),
  );
}

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
    // B4 (LIA-404): checkpointer-backed sessions landed — a stored
    // session_id is a real, resumable thread identifier.
    expect(caps.persistent_sessions).toBe(true);
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
    invokeMockEcho(
      { content: 'search the web for X' },
      {
        content: '',
        tool_calls: [{ name: 'web_search', args: { query: 'X' } }],
      },
      { content: 'Here is what I found about X.' },
    );

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

    // The invoke input remains the bare prompt; session-open repository
    // context is delivered separately through prompt-lifecycle's
    // systemMessage boundary. B4 (LIA-404): invoke gains a second argument —
    // the checkpointer thread_id, which must be the SAME id the
    // RunResult.sessionRef carries (the session row references exactly the
    // checkpointer state this turn wrote). D5 (LIA-419): the single input
    // message is now a HumanMessage carrying a per-turn stable `id` (rather
    // than a bare `{role, content}` literal) — checked structurally via
    // toMatchObject (HumanMessage carries additional LangChain-internal
    // fields a strict toEqual would reject) plus an explicit `id` presence
    // check, since the id's value is generated fresh per call.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [invokeInput, invokeConfig] = invokeMock.mock.calls[0] as [
      { messages: Array<{ id?: unknown; content?: unknown; type?: unknown }> },
      unknown,
    ];
    expect(invokeInput.messages).toHaveLength(1);
    expect(invokeInput.messages[0]).toMatchObject({
      type: 'human',
      content: 'find X',
    });
    expect(typeof invokeInput.messages[0].id).toBe('string');
    expect(invokeConfig).toEqual({
      configurable: { thread_id: result.sessionRef?.session_id },
    });

    // OAuth-vs-API-key branching happened via detectAuthMode, and a
    // per-group token was minted.
    expect(getOrCreateGroupTokenMock).toHaveBeenCalledWith('test-folder');

    // B2 (LIA-402): runTurn wires the middleware stack into createAgent in
    // canonical order — all four layers enabled by default (AC1 at the
    // runtime level; composition semantics are proven in
    // middleware-stack.test.ts's AC4 ordering test). B3 (LIA-403) appends
    // its prompt-lifecycle middleware LAST — appended, never prepended, so
    // B2's AC1-locked order is untouched. D5 (LIA-419) prepends
    // context-compaction AHEAD of B2's stack — it must replace stale
    // checkpointed history before memory's beforeModel hook appends
    // turn-specific recalled context, so the leading array position is
    // required, not incidental.
    const createAgentArgs = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string }>;
      checkpointer?: unknown;
    };
    expect(createAgentArgs.middleware?.map((m) => m.name)).toEqual([
      'context-compaction',
      'permissions',
      'wardens',
      'memory',
      'telemetry',
      'prompt-lifecycle',
    ]);

    // B4 (LIA-404): the checkpointer is genuinely wired into createAgent —
    // identity check against the stub instance (toBe), not just "some field
    // is present", so a silently-dropped checkpointer can't false-negative
    // this ticket's core AC.
    expect(createAgentArgs.checkpointer).toBe(checkpointerStub);
  });

  it('branches to OAuth-mode client construction when detectAuthMode() returns "oauth"', async () => {
    detectAuthModeMock.mockReturnValue('oauth');
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });

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

describe('DeusNativeBackend — completed-turn transcript wiring (LIA-427/F5)', () => {
  const backend = createDeusNativeRuntime(stubDeps);

  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
    buildNestedDispatchToolMock.mockClear();
  });

  it('writes one successful turn after terminal events with exact prompt, ids, model, tools, usage, and timestamps', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho(
      {
        id: 'tool-message',
        type: 'ai',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            name: 'web_search',
            args: { query: 'native source' },
          },
          {
            id: 'call-2',
            name: 'web_fetch',
            args: { url: 'https://example.com' },
          },
        ],
        usage_metadata: {
          input_tokens: 40,
          output_tokens: 10,
          total_tokens: 50,
        },
      },
      {
        id: 'assistant-final',
        type: 'ai',
        content: 'Stored answer.',
        usage_metadata: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
        },
      },
    );
    const order: string[] = [];
    appendTranscriptMock.mockImplementation(async () => {
      order.push('writer');
      return { ok: true, path: '/transcript' };
    });

    const result = await backend.runTurn(
      {
        prompt: 'Store this exact prompt.',
        groupFolder: 'whatsapp_main',
        chatJid: 'test@g.us',
        isControlGroup: false,
        cwd: '/absolute/project/path',
      },
      { backend: 'deus-native', session_id: 'resumed-native-session' },
      (event) => {
        order.push(event.type);
      },
    );

    expect(result).toEqual({
      status: 'success',
      result: 'Stored answer.',
      sessionRef: {
        backend: 'deus-native',
        session_id: 'resumed-native-session',
      },
      usage: { inputTokens: 160, outputTokens: 40, totalTokens: 200 },
    });
    expect(order.slice(-3)).toEqual(['output_text', 'turn_complete', 'writer']);
    expect(appendTranscriptMock).toHaveBeenCalledTimes(1);
    const input = appendTranscriptMock.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      sessionId: 'resumed-native-session',
      groupFolder: 'whatsapp_main',
      cwd: '/absolute/project/path',
      prompt: 'Store this exact prompt.',
      assistantText: 'Stored answer.',
      assistantMessageId: 'assistant-final',
      primaryModel: 'claude-opus-4-8',
      toolCalls: [
        {
          id: 'call-1',
          name: 'web_search',
          input: { query: 'native source' },
        },
        {
          id: 'call-2',
          name: 'web_fetch',
          input: { url: 'https://example.com' },
        },
      ],
      usageEvents: [
        {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          inputTokens: 40,
          outputTokens: 10,
          totalTokens: 50,
        },
        {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      ],
    });
    expect(input.userMessageId).toEqual(expect.any(String));
    expect(input.startedAt).toBeInstanceOf(Date);
    expect(input.completedAt).toBeInstanceOf(Date);
    expect(input.completedAt.getTime()).toBeGreaterThanOrEqual(
      input.startedAt.getTime(),
    );
  });

  it('uses a minted outgoing id for a new session and the same resumed id on later turns', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ id: 'assistant', type: 'ai', content: 'ok' });

    const fresh = await backend.runTurn(
      {
        prompt: 'fresh',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );
    const freshWriterId = appendTranscriptMock.mock.calls[0]?.[0].sessionId;
    expect(freshWriterId).toBe(fresh.sessionRef?.session_id);

    appendTranscriptMock.mockClear();
    const resumed = await backend.runTurn(
      {
        prompt: 'resumed',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: 'stable-session-id' },
      () => {},
    );
    expect(resumed.sessionRef?.session_id).toBe('stable-session-id');
    expect(appendTranscriptMock.mock.calls[0]?.[0].sessionId).toBe(
      'stable-session-id',
    );
  });

  it('tees nested and parent usage events unchanged and preserves unreported token absence', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockImplementation(
      async (input: { messages: Array<{ id?: string }> }) => {
        const nestedDeps = buildNestedDispatchToolMock.mock.calls[0]?.[0] as {
          onUsage: (observation: {
            message: unknown;
            model: string;
          }) => Promise<void>;
        };
        await nestedDeps.onUsage({
          message: {
            id: 'nested-ai',
            type: 'ai',
            content: 'nested',
            usage_metadata: {
              input_tokens: 7,
              output_tokens: 3,
              total_tokens: 10,
            },
          },
          model: 'claude-haiku-4-5-20251001',
        });
        return {
          messages: [
            input.messages[0],
            { id: 'parent-ai', type: 'ai', content: 'parent' },
          ],
        };
      },
    );
    const events: RuntimeEvent[] = [];

    const result = await backend.runTurn(
      {
        prompt: 'dispatch',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: 'usage-session' },
      (event) => {
        events.push(event);
      },
    );

    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    const outwardUsage = events.filter((event) => event.type === 'usage');
    expect(outwardUsage).toEqual([
      {
        type: 'usage',
        sessionId: 'usage-session',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
      {
        type: 'usage',
        sessionId: 'usage-session',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
    ]);
    const writerUsage = appendTranscriptMock.mock.calls[0]?.[0].usageEvents;
    expect(writerUsage).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      },
    ]);
    expect(writerUsage[1].inputTokens).toBeUndefined();
    expect(writerUsage[1]).not.toHaveProperty('inputTokens');
    expect(JSON.stringify(writerUsage)).not.toContain('provenance');
  });

  it.each([
    [
      'ok:false',
      async () => ({ ok: false as const, error: new Error('disk full') }),
    ],
    [
      'unexpected rejection',
      async () => Promise.reject(new Error('mock reject')),
    ],
  ])(
    'keeps the successful result and terminal events on writer %s',
    async (_label, writer) => {
      createAgentMock.mockReturnValue({ invoke: invokeMock });
      invokeMockEcho({
        id: 'assistant',
        type: 'ai',
        content: 'answer survives',
        usage_metadata: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
        },
      });
      appendTranscriptMock.mockImplementation(writer);
      const consoleWarn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      const events: RuntimeEvent[] = [];

      const result = await backend.runTurn(
        {
          prompt: 'writer failure',
          groupFolder: 'test-folder',
          chatJid: 'test@g.us',
          isControlGroup: false,
        },
        { backend: 'deus-native', session_id: 'failure-session' },
        (event) => {
          events.push(event);
        },
      );

      expect(result).toEqual({
        status: 'success',
        result: 'answer survives',
        sessionRef: {
          backend: 'deus-native',
          session_id: 'failure-session',
        },
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
      expect(events.at(-2)).toEqual({
        type: 'output_text',
        text: 'answer survives',
      });
      expect(events.at(-1)).toEqual({ type: 'turn_complete' });
      if (_label === 'unexpected rejection') {
        expect(consoleWarn).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('never writes when invoke fails before successful completion', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockRejectedValue(new Error('provider failed'));

    const result = await backend.runTurn(
      {
        prompt: 'will fail',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: 'error-session' },
      () => {},
    );

    expect(result.status).toBe('error');
    expect(appendTranscriptMock).not.toHaveBeenCalled();
  });

  it('never writes when turn_complete rejects after output_text succeeds', async () => {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ id: 'assistant', type: 'ai', content: 'not completed' });
    const events: RuntimeEvent[] = [];

    const result = await backend.runTurn(
      {
        prompt: 'terminal failure',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: 'terminal-error-session' },
      (event) => {
        events.push(event);
        if (event.type === 'turn_complete') {
          throw new Error('terminal sink failed');
        }
      },
    );

    expect(result).toEqual({
      status: 'error',
      result: null,
      error: 'terminal sink failed',
    });
    expect(events.at(-2)).toEqual({
      type: 'output_text',
      text: 'not completed',
    });
    expect(events.at(-1)).toEqual({ type: 'turn_complete' });
    expect(appendTranscriptMock).not.toHaveBeenCalled();
  });
});

// ── B7 (LIA-407): permission-profile wiring at the PRODUCTION call site ───
//
// These tests prove the runContext.backendConfig.permissionProfile seam:
// omitted => the 'default' allow-all profile (today's behavior, unchanged);
// 'read-only' => the fail-closed read-only policy; an invalid value fails
// visibly BEFORE createAgent. createAgent is mocked (as everywhere in this
// file) but buildMiddlewareStack/createMiddleware are REAL, so the
// middleware objects captured off createAgentMock are the genuine
// permissions layer — invoking their wrapToolCall hook directly proves
// which policy production actually wired, not just which string was passed.

import { ToolMessage } from '@langchain/core/messages';

/** Minimal ToolCallRequest stand-in for direct wrapToolCall invocation
 *  (same shape as middleware-stack.test.ts's helper — the hook only reads
 *  toolCall.{name,id} and passes the request through). */
function makeToolCallRequest(name: string, args: Record<string, unknown>) {
  return {
    toolCall: { name, args, id: 'call_wiring_1', type: 'tool_call' as const },
    tool: undefined,
    state: {},
    runtime: {},
  };
}

async function invokeWrapToolCall(
  middleware: { wrapToolCall?: unknown },
  request: unknown,
  handler: (req: unknown) => ToolMessage,
): Promise<unknown> {
  const hook = middleware.wrapToolCall as (
    request: unknown,
    handler: unknown,
  ) => Promise<unknown> | unknown;
  return await hook(request, handler);
}

describe('DeusNativeBackend — permission profile wiring (B7/LIA-407)', () => {
  const backend = createDeusNativeRuntime(stubDeps);

  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
  });

  async function runTurnWith(backendConfig?: Record<string, unknown>) {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });
    return backend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
        ...(backendConfig !== undefined ? { backendConfig } : {}),
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );
  }

  function capturedPermissionsMiddleware() {
    const args = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string; wrapToolCall?: unknown }>;
    };
    // D5 (LIA-419) prepends context-compaction ahead of B2's stack, so
    // 'permissions' now sits at index 1, not 0.
    const permissions = args.middleware?.[1];
    expect(permissions?.name).toBe('permissions');
    return permissions as { name: string; wrapToolCall?: unknown };
  }

  it("omitted backendConfig wires the default profile: a mutation-named call is still allowed (today's behavior, unchanged)", async () => {
    const result = await runTurnWith(undefined);
    expect(result.status).toBe('success');

    const permissions = capturedPermissionsMiddleware();
    const handler = vi.fn(
      () => new ToolMessage({ content: 'ran', tool_call_id: 'call_wiring_1' }),
    );
    await invokeWrapToolCall(
      permissions,
      makeToolCallRequest('write_file', { path: '/x', content: 'y' }),
      handler,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('backendConfig.permissionProfile "read-only" wires the read-only policy: mutation denied, read allowed — with canonical order retained', async () => {
    const result = await runTurnWith({ permissionProfile: 'read-only' });
    expect(result.status).toBe('success');

    // Canonical order is untouched by the profile selection (B2's AC1 +
    // B3's appended prompt-lifecycle + D5's prepended context-compaction).
    const createAgentArgs = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string }>;
    };
    expect(createAgentArgs.middleware?.map((m) => m.name)).toEqual([
      'context-compaction',
      'permissions',
      'wardens',
      'memory',
      'telemetry',
      'prompt-lifecycle',
    ]);

    const permissions = capturedPermissionsMiddleware();

    // A mutation tool is DENIED by the wired policy: handler untouched,
    // synthetic error ToolMessage naming the profile.
    const deniedHandler = vi.fn(
      () => new ToolMessage({ content: 'ran', tool_call_id: 'call_wiring_1' }),
    );
    const denial = (await invokeWrapToolCall(
      permissions,
      makeToolCallRequest('write_file', { path: '/x', content: 'y' }),
      deniedHandler,
    )) as ToolMessage;
    expect(deniedHandler).not.toHaveBeenCalled();
    expect(denial).toBeInstanceOf(ToolMessage);
    expect(denial.status).toBe('error');
    const content =
      typeof denial.content === 'string'
        ? denial.content
        : JSON.stringify(denial.content);
    expect(content).toContain('permission_denied');
    expect(content).toContain('read-only');

    // A read tool still flows through — today's web_search/web_fetch calls
    // remain allowed under the read-only profile (plan AC3).
    const allowedHandler = vi.fn(
      () => new ToolMessage({ content: 'ok', tool_call_id: 'call_wiring_1' }),
    );
    await invokeWrapToolCall(
      permissions,
      makeToolCallRequest('web_search', { query: 'x' }),
      allowedHandler,
    );
    expect(allowedHandler).toHaveBeenCalledTimes(1);
  });

  it('an unrecognized profile name fails visibly BEFORE createAgent (status error, never a silent fallback to default)', async () => {
    const result = await runTurnWith({ permissionProfile: 'totally-invalid' });
    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain(
      'unknown permission profile "totally-invalid"',
    );
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('a non-string permissionProfile value fails visibly BEFORE createAgent', async () => {
    const result = await runTurnWith({ permissionProfile: 42 });
    expect(result.status).toBe('error');
    expect(result.error).toContain(
      'backendConfig.permissionProfile must be a string',
    );
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('LIA-444 regression: read-only profile denies dispatch_nested_agent before any nested handler/model resolver is reached — fail-closed default deny, since the tool is not in either the allow or deny list', async () => {
    const result = await runTurnWith({ permissionProfile: 'read-only' });
    expect(result.status).toBe('success');

    const permissions = capturedPermissionsMiddleware();
    const nestedHandler = vi.fn(
      () => new ToolMessage({ content: 'ran', tool_call_id: 'call_wiring_1' }),
    );
    const denial = (await invokeWrapToolCall(
      permissions,
      makeToolCallRequest('dispatch_nested_agent', {
        agentId: 'researcher',
        prompt: 'do something',
      }),
      nestedHandler,
    )) as ToolMessage;
    // The handler stands in for the real nested-dispatch tool (which itself
    // resolves the model and role); it must never be invoked when the
    // permissions layer denies the call first.
    expect(nestedHandler).not.toHaveBeenCalled();
    expect(denial).toBeInstanceOf(ToolMessage);
    expect(denial.status).toBe('error');
    const content =
      typeof denial.content === 'string'
        ? denial.content
        : JSON.stringify(denial.content);
    expect(content).toContain('permission_denied');
  });
});

// ── D1 (LIA-415): memory retrieval wiring at the PRODUCTION call site ─────
//
// buildMiddlewareStack is a delegating spy over the REAL implementation
// (see the module mock at the top of this file), so these tests inspect the
// genuine deps runTurn supplies: a control-group turn must carry the
// submitted prompt plus the backend-scoped session id into the memory
// layer, and a non-control-group turn must omit memoryRequest entirely
// (personal-vault isolation — the placeholder seam's documented leak
// concern). No live model, Python, vault, or Ollama call happens anywhere
// here: createAgent is mocked, so no beforeModel hook (and therefore no
// real subprocess adapter) ever fires.

import type { BuildMiddlewareStackDeps } from './middleware-stack.js';

describe('DeusNativeBackend — memory retrieval wiring (D1/LIA-415)', () => {
  const backend = createDeusNativeRuntime(stubDeps);

  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
    // mockClear, NOT mockReset — the spy must keep delegating to the real
    // buildMiddlewareStack.
    buildMiddlewareStackSpy.mockClear();
  });

  async function runTurnAs(isControlGroup: boolean) {
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });
    return backend.runTurn(
      {
        prompt: 'a generic fixture prompt about testing',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );
  }

  function suppliedDeps(): BuildMiddlewareStackDeps {
    expect(buildMiddlewareStackSpy).toHaveBeenCalledTimes(1);
    // Guard before the cast: a future arg-order change to
    // buildMiddlewareStack must fail loudly here, not produce undefined
    // deps and vacuously-passing assertions downstream.
    const deps = buildMiddlewareStackSpy.mock.calls[0]?.[1];
    expect(deps).toBeDefined();
    return deps as BuildMiddlewareStackDeps;
  }

  it('a control-group turn supplies memoryRequest with the submitted prompt and the backend-scoped session id', async () => {
    const result = await runTurnAs(true);
    expect(result.status).toBe('success');

    const deps = suppliedDeps();
    expect(deps.memoryRequest).toEqual({
      prompt: 'a generic fixture prompt about testing',
      // The SAME id the RunResult.sessionRef carries — the checkpointer
      // thread_id computed at the top of the turn, so the hook's
      // session-concept/dedup state keys to the real session.
      sessionId: result.sessionRef?.session_id,
    });
    // No test-only adapter override leaks into production wiring.
    expect(deps.memoryRetrievalAdapter).toBeUndefined();

    // Middleware ordering is untouched by the new dep (B2's locked order +
    // B3's appended prompt-lifecycle).
    const createAgentArgs = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string }>;
    };
    expect(createAgentArgs.middleware?.map((m) => m.name)).toEqual([
      'context-compaction',
      'permissions',
      'wardens',
      'memory',
      'telemetry',
      'prompt-lifecycle',
    ]);
  });

  it('a non-control-group turn omits memoryRequest entirely (personal-vault isolation, AAG-014)', async () => {
    const result = await runTurnAs(false);
    expect(result.status).toBe('success');

    const deps = suppliedDeps();
    expect(deps.memoryRequest).toBeUndefined();
    expect('memoryRequest' in deps).toBe(false);

    // Ordering unchanged here too.
    const createAgentArgs = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string }>;
    };
    expect(createAgentArgs.middleware?.map((m) => m.name)).toEqual([
      'context-compaction',
      'permissions',
      'wardens',
      'memory',
      'telemetry',
      'prompt-lifecycle',
    ]);
  });
});

// ── Activity broadcaster decorator integration (LIA-432/G5) ────────────────
//
// The decorator itself (event tee order, synthetic-error rules, downstream
// sink transparency) is unit-tested against a FAKE runtime in
// activity-broadcaster.test.ts. This block locks the one piece that requires
// the REAL DeusNativeRuntime: its catch-path returns `RunResult.status ===
// 'error'` WITHOUT ever calling `eventSink` with a `type: 'error'` event (see
// the "runTurn returns error when the proxy token mint fails" case above) —
// proving `withRuntimeActivityBroadcast` synthesizes exactly one terminal
// broadcaster-only error for that real shape, without altering the original
// downstream sink or RunResult.
describe('DeusNativeBackend — activity broadcaster decorator integration (LIA-432/G5)', () => {
  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
  });

  it('publishes one terminal broadcaster-only error envelope for a returned error with no emitted error event, without changing the downstream sink or RunResult', async () => {
    getOrCreateGroupTokenMock.mockImplementation(() => {
      throw new Error(
        'getOrCreateGroupToken: folder is a publicIngress folder',
      );
    });

    const backend = createDeusNativeRuntime(stubDeps);
    const broadcaster = new RuntimeActivityBroadcaster();
    const received: RuntimeActivityEnvelope[] = [];
    broadcaster.subscribe((e) => received.push(e));
    const decorated = withRuntimeActivityBroadcast(backend, broadcaster);

    const events: RuntimeEvent[] = [];
    const result = await decorated.runTurn(
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

    // RunResult is unchanged from the undecorated behavior asserted above.
    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toContain('publicIngress');
    // DeusNativeRuntime's catch path never calls eventSink — the original
    // downstream sink still sees zero events, decorator or not.
    expect(events).toHaveLength(0);
    expect(createAgentMock).not.toHaveBeenCalled();

    // The broadcaster received exactly one synthetic terminal error, never
    // injected into the caller's own sink (the empty `events` array above
    // already proves the latter).
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('error');
    expect(received[0].payload).toMatchObject({
      error: expect.stringContaining('publicIngress'),
    });
    expect(received[0].source).toEqual({
      backend: 'deus-native',
      groupFolder: 'nonexistent',
      chatJid: 'test@g.us',
    });
  });
});

// ── C1 (LIA-409): wardens layer — real repo-root/cwd wiring at the
// PRODUCTION call site ───────────────────────────────────────────────────
//
// buildWardensMiddleware itself is unit-tested in middleware-stack.test.ts;
// this proves runTurn threads the RIGHT cwd into it — `worktreePath` ahead
// of `cwd` — the same worktreePath-wins seam the permissions-profile block
// above proves for `backendConfig.permissionProfile`.

describe('DeusNativeBackend — wardens cwd wiring (C1/LIA-409)', () => {
  const backend = createDeusNativeRuntime(stubDeps);
  const execFileMock = vi.mocked(execFile);

  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
    execFileMock.mockReset();
  });

  function capturedWardensMiddleware() {
    const args = createAgentMock.mock.calls[0]?.[0] as {
      middleware?: Array<{ name: string; wrapToolCall?: unknown }>;
    };
    // D5 (LIA-419) prepends context-compaction ahead of B2's stack, so
    // 'wardens' now sits at index 2, not 1.
    const wardens = args.middleware?.[2];
    expect(wardens?.name).toBe('wardens');
    return wardens as { name: string; wrapToolCall?: unknown };
  }

  it('threads the absolute worktreePath ahead of cwd into wardens stdin events', async () => {
    let capturedStdin = '';
    execFileMock.mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: null, stdout: string) => void,
    ) => {
      const child = {
        stdin: {
          on: () => child.stdin,
          end: (data: string) => {
            capturedStdin = data;
            queueMicrotask(() => callback(null, ''));
          },
        },
      };
      return child as unknown as ReturnType<typeof execFile>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });

    // worktreePath is THIS worktree's real root (a genuine git repo, so the
    // production repo-root resolution succeeds for real); cwd is a
    // deliberately different, never-consulted value proving worktreePath
    // wins outright.
    const worktreePath = process.cwd();
    const result = await backend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
        cwd: '/definitely/not/the/worktree/path',
        worktreePath,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );

    expect(result.status).toBe('success');

    const wardens = capturedWardensMiddleware();
    const handler = vi.fn(
      () => new ToolMessage({ content: 'ok', tool_call_id: 'call_wiring_1' }),
    );
    await invokeWrapToolCall(
      wardens,
      makeToolCallRequest('apply_patch', { patch: 'x' }),
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = JSON.parse(capturedStdin) as { cwd: string };
    expect(event.cwd).toBe(worktreePath);
    expect(event.cwd).not.toBe('/definitely/not/the/worktree/path');
  });

  it('threads the SAME resolved wardenCwd into a nested-dispatch child middleware stack (B8/LIA-408 integration)', async () => {
    let capturedStdin = '';
    execFileMock.mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: null, stdout: string) => void,
    ) => {
      const child = {
        stdin: {
          on: () => child.stdin,
          end: (data: string) => {
            capturedStdin = data;
            queueMicrotask(() => callback(null, ''));
          },
        },
      };
      return child as unknown as ReturnType<typeof execFile>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });
    buildNestedDispatchToolMock.mockClear();

    const worktreePath = process.cwd();
    const result = await backend.runTurn(
      {
        prompt: 'test',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
        cwd: '/definitely/not/the/worktree/path',
        worktreePath,
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );
    expect(result.status).toBe('success');

    // The real `CreateNestedDispatcherDeps` runTurn supplies to
    // buildNestedDispatchTool (stubbed at the module boundary — see the
    // hoisted mock — so no live dispatcher is needed here).
    expect(buildNestedDispatchToolMock).toHaveBeenCalledTimes(1);
    const deps = buildNestedDispatchToolMock.mock.calls[0]?.[0] as {
      buildChildMiddleware?: () => Array<{
        name: string;
        wrapToolCall?: unknown;
      }>;
    };
    expect(deps.buildChildMiddleware).toBeDefined();

    // Calling the REAL factory produces a REAL wardens middleware — same
    // pattern as capturedWardensMiddleware() above, just for the child
    // stack instead of the parent's.
    const childMiddleware = deps.buildChildMiddleware!();
    const childWardens = childMiddleware[1];
    expect(childWardens?.name).toBe('wardens');

    const handler = vi.fn(
      () => new ToolMessage({ content: 'ok', tool_call_id: 'call_wiring_1' }),
    );
    await invokeWrapToolCall(
      childWardens,
      makeToolCallRequest('apply_patch', { patch: 'x' }),
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const event = JSON.parse(capturedStdin) as { cwd: string };
    expect(event.cwd).toBe(worktreePath);
    expect(event.cwd).not.toBe('/definitely/not/the/worktree/path');
  });
});

describe('DeusNativeRuntime — SubAgent chat-dispatch role catalog (LIA-444)', () => {
  beforeEach(() => {
    createAgentMock.mockReset();
    invokeMock.mockReset();
    detectAuthModeMock.mockReturnValue('api-key');
    getOrCreateGroupTokenMock.mockReset();
    getOrCreateGroupTokenMock.mockReturnValue('fake-proxy-token');
    buildNestedDispatchToolMock.mockClear();
    loadAgentSpecsSpy.mockClear();
  });

  it('production-boundary regression: the tool builder receives an agentSpecs map with EXACTLY the allowlisted keys — "researcher" present, "code-reviewer"/"plan-reviewer" absent — never the raw, unfiltered loadAgentSpecs() catalog', async () => {
    const backend = createDeusNativeRuntime(stubDeps);
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });

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
    expect(result.status).toBe('success');

    expect(buildNestedDispatchToolMock).toHaveBeenCalledTimes(1);
    const options = buildNestedDispatchToolMock.mock.calls[0]?.[1] as {
      agentSpecs?: ReadonlyMap<string, unknown>;
    };
    expect(options.agentSpecs).toBeDefined();
    const keys = [...(options.agentSpecs?.keys() ?? [])];
    // This is the actual production-boundary assertion (round-2 review
    // finding): a nested-dispatch-tool-level test alone cannot prove the
    // BACKEND passes the filtered map rather than the raw 28-role one.
    expect(keys).toEqual(['researcher']);
    expect(keys).not.toContain('code-reviewer');
    expect(keys).not.toContain('plan-reviewer');
    expect(keys).not.toContain('ai-eng-warden');
  });

  it('startup resilience: a malformed unrelated .claude/agents/*.md spec must not crash DeusNativeRuntime construction — falls back to an empty, safe catalog instead', async () => {
    loadAgentSpecsSpy.mockImplementationOnce(() => {
      throw new Error(
        'Invalid agent specifications:\n- unrelated-warden.md: frontmatter.description: required',
      );
    });

    // Construction itself must not throw.
    const backend = createDeusNativeRuntime(stubDeps);
    expect(backend).toBeDefined();

    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMockEcho({ content: 'ok' });
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
    // The turn itself still succeeds — the resilience fallback is scoped
    // entirely to the dispatch catalog, not the whole runtime.
    expect(result.status).toBe('success');

    const options = buildNestedDispatchToolMock.mock.calls[0]?.[1] as {
      agentSpecs?: ReadonlyMap<string, unknown>;
    };
    expect(options.agentSpecs?.size).toBe(0);
  });
});
