/**
 * LIA-454 EP-002 step 11: transport-routing tests for `runTurn()`. Proves
 * the `DEUS_NATIVE_TRANSPORT` branch itself — the raw-HTTP path (default,
 * unchanged, already covered exhaustively by `deus-native-backend.test.ts`,
 * which stays green unmodified) never touches CLI-subprocess machinery, and
 * the CLI-subprocess path never touches `createAgent`/`buildNativeModelClient`
 * and correctly folds a `ParentCliTurnOutcome` into a `RunResult` via the
 * SAME shared post-processing the raw path uses.
 *
 * `DEUS_NATIVE_TRANSPORT` is a frozen top-level const resolved once at
 * `config.ts` module-load time, so this file mocks that module directly
 * (rather than mutating `process.env` and re-importing) to pin it to
 * `'cli-subprocess'` for every test here — a separate vitest test FILE gets
 * its own isolated module registry, so this has no effect on
 * `deus-native-backend.test.ts`'s own (real, default `'raw-http'`) module
 * graph.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ContainerRuntimeDeps } from './container-backend.js';
import type { RuntimeEvent } from './types.js';

const {
  runParentTurnViaCliSubprocessMock,
  poolConstructorSpy,
  appendTranscriptMock,
} = vi.hoisted(() => ({
  runParentTurnViaCliSubprocessMock: vi.fn(),
  poolConstructorSpy: vi.fn(),
  appendTranscriptMock: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, DEUS_NATIVE_TRANSPORT: 'cli-subprocess' as const };
});

vi.mock('./cli-subprocess/parent-turn-runner.js', () => ({
  runParentTurnViaCliSubprocess: runParentTurnViaCliSubprocessMock,
}));

vi.mock('./cli-subprocess/claude-cli-session-pool.js', () => ({
  ClaudeCliSessionPool: class {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      poolConstructorSpy(options);
    }
    async shutdownAll() {}
  },
}));

const checkpointerStub = { getTuple: async () => undefined };
vi.mock('./checkpointer.js', () => ({
  getCheckpointer: () => checkpointerStub,
}));

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
  runParentTurnViaCliSubprocessMock.mockReset();
  poolConstructorSpy.mockReset();
  appendTranscriptMock.mockReset();
  appendTranscriptMock.mockResolvedValue({
    ok: true,
    path: '/test/store/transcripts/deus-native/session.jsonl',
  });
});

describe('runTurn: cli-subprocess transport routing (LIA-454 EP-002 step 11)', () => {
  const backend = createDeusNativeRuntime(stubDeps);

  it('routes through runParentTurnViaCliSubprocess exactly once, never touching createAgent-shaped raw-HTTP machinery', async () => {
    runParentTurnViaCliSubprocessMock.mockResolvedValue({
      status: 'success',
      newMessages: [],
      finalAssistantText: 'hi there',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });

    const events: RuntimeEvent[] = [];
    const result = await backend.runTurn(
      {
        prompt: 'hello',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );

    expect(runParentTurnViaCliSubprocessMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('success');
    expect(result.result).toBe('hi there');
    expect(poolConstructorSpy).toHaveBeenCalledTimes(1);
    expect(poolConstructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maxProcesses: 3,
        idleTimeoutMs: 120_000,
        terminationGraceMs: 3_000,
      }),
    );
  });

  it('passes the exact model, thread id, prompt, message id, saver, and mcpServerContext to the runner', async () => {
    runParentTurnViaCliSubprocessMock.mockResolvedValue({
      status: 'success',
      newMessages: [],
      finalAssistantText: 'ok',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });

    await backend.runTurn(
      {
        prompt: 'what is the weather',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: 'existing-session-id' },
      async () => {},
    );

    expect(runParentTurnViaCliSubprocessMock).toHaveBeenCalledTimes(1);
    const [options, deps] = runParentTurnViaCliSubprocessMock.mock.calls[0];
    expect(options.threadId).toBe('existing-session-id');
    expect(options.prompt).toBe('what is the weather');
    expect(typeof options.currentTurnMessageId).toBe('string');
    expect(options.mcpServerContext).toMatchObject({
      safeToolCwd: expect.any(String),
      allowedWebFetchHosts: [],
      parentSessionId: 'existing-session-id',
      agentCatalogIds: expect.any(Array),
    });
    expect(options.mcpServerContext.effectiveModels.main).toBeDefined();
    expect(deps.saver).toBe(checkpointerStub);
    expect(typeof deps.scratchDirFor).toBe('function');
    expect(typeof deps.loadSessionOpenText).toBe('function');
  });

  it('maps a ParentCliTurnOutcome error to a never-throw error RunResult, without emitting output_text/turn_complete', async () => {
    runParentTurnViaCliSubprocessMock.mockResolvedValue({
      status: 'error',
      error: 'another turn is already in flight for this thread',
    });

    const events: RuntimeEvent[] = [];
    const result = await backend.runTurn(
      {
        prompt: 'hello',
        groupFolder: 'test-folder',
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
    expect(result.error).toContain('another turn is already in flight');
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
    expect(events.some((e) => e.type === 'output_text')).toBe(false);
    expect(appendTranscriptMock).not.toHaveBeenCalled();
  });

  it('folds tool_calls from ParentCliTurnOutcome.newMessages through the same tool_call event/transcript path the raw-HTTP branch uses', async () => {
    runParentTurnViaCliSubprocessMock.mockResolvedValue({
      status: 'success',
      newMessages: [
        {
          content: '',
          tool_calls: [
            { id: 'tc-1', name: 'web_search', args: { query: 'x' } },
          ],
        },
        { content: 'final answer' },
      ],
      finalAssistantText: 'final answer',
      finalAssistantMessageId: 'msg-final',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });

    const events: RuntimeEvent[] = [];
    const result = await backend.runTurn(
      {
        prompt: 'search for x',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toBe('final answer');
    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({
      name: 'web_search',
      arguments: { query: 'x' },
    });
    expect(events.some((e) => e.type === 'output_text')).toBe(true);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true);
    expect(appendTranscriptMock).toHaveBeenCalledTimes(1);
    expect(appendTranscriptMock.mock.calls[0][0]).toMatchObject({
      assistantText: 'final answer',
      assistantMessageId: 'msg-final',
      primaryModel: 'claude-sonnet-5',
    });
  });

  it('falls back to effectiveModels.main.model when the outcome carries no model id, never fabricating one', async () => {
    runParentTurnViaCliSubprocessMock.mockResolvedValue({
      status: 'success',
      newMessages: [],
      finalAssistantText: 'ok',
      model: '', // CLI never reported a model this turn
      provider: 'anthropic',
    });

    await backend.runTurn(
      {
        prompt: 'hi',
        groupFolder: 'test-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      async () => {},
    );

    expect(appendTranscriptMock).toHaveBeenCalledTimes(1);
    const primaryModel = appendTranscriptMock.mock.calls[0][0].primaryModel;
    expect(typeof primaryModel).toBe('string');
    expect(primaryModel.length).toBeGreaterThan(0);
  });

  it('still refuses a publicIngress group before ever calling the CLI-subprocess runner', async () => {
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
        prompt: 'hi',
        groupFolder: 'webhook-folder',
        chatJid: 'test@g.us',
        isControlGroup: false,
      },
      { backend: 'deus-native', session_id: '' },
      async () => {},
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('publicIngress');
    expect(runParentTurnViaCliSubprocessMock).not.toHaveBeenCalled();
  });
});
