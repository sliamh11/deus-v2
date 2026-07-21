/**
 * Unit tests for the deus-native CLI chat controller (LIA-428 / G1,
 * LIA-430 / G3):
 * session lifecycle (mint/persist/resume), event normalization, and the
 * foreign-ref/error guards — against an injected fake runtime and an
 * in-memory session store.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type {
  AgentRuntime,
  RunContext,
  RunResult,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeSession,
} from '../agent-runtimes/types.js';
import {
  createDeusNativeChatController,
  formatToolUse,
  NativeChatBusyError,
  CLI_CHAT_GROUP_FOLDER,
  CLI_CHAT_JID,
  type ChatDisplayEvent,
  type DeusNativeChatOptions,
  type NativeChatSessionStore,
} from './deus-native-chat.js';

const MINTED_ID = '22222222-2222-4222-8222-222222222222';
const OPTIONS: DeusNativeChatOptions = {
  cwd: '/tmp/somewhere',
  resume: true,
  models: {
    main: { provider: 'anthropic', model: 'claude-opus-4-8' },
    roles: {},
  },
};

interface FakeRuntimeScript {
  /** Events pushed to the sink during runTurn, per call (index = call #). */
  events?: RuntimeEvent[][];
  /** RunResult per call; last entry repeats. */
  results?: Array<Partial<RunResult>>;
  streaming?: boolean;
  name?: string;
}

function makeFakeRuntime(script: FakeRuntimeScript = {}) {
  const calls: Array<{ runContext: RunContext; sessionRef: RuntimeSession }> =
    [];
  const closed: RuntimeSession[] = [];
  let startOrResumeCalls = 0;
  const runtime: AgentRuntime = {
    name: () => (script.name ?? 'deus-native') as 'deus-native',
    capabilities: () => ({
      shell: false,
      filesystem: false,
      web: true,
      multimodal: false,
      handoffs: false,
      persistent_sessions: true,
      tool_streaming: script.streaming ?? false,
    }),
    startOrResume: async () => {
      startOrResumeCalls += 1;
      return { backend: 'deus-native', session_id: '' };
    },
    runTurn: async (
      runContext: RunContext,
      sessionRef: RuntimeSession,
      eventSink: RuntimeEventSink,
    ) => {
      const callIndex = calls.length;
      calls.push({ runContext, sessionRef });
      for (const event of script.events?.[callIndex] ?? []) {
        await eventSink(event);
      }
      const results = script.results ?? [{}];
      const partial = results[Math.min(callIndex, results.length - 1)] ?? {};
      return {
        status: 'success',
        result: 'answer',
        sessionRef: { backend: 'deus-native', session_id: MINTED_ID },
        ...partial,
      } as RunResult;
    },
    close: async (sessionRef: RuntimeSession) => {
      closed.push(sessionRef);
    },
  };
  return {
    runtime,
    calls,
    closed,
    get startOrResumeCalls() {
      return startOrResumeCalls;
    },
  };
}

function memoryStore(): NativeChatSessionStore & {
  rows: Map<string, RuntimeSession>;
} {
  const rows = new Map<string, RuntimeSession>();
  return {
    rows,
    get: (groupFolder, backend) => rows.get(`${groupFolder} ${backend}`),
    set: (groupFolder, session) =>
      rows.set(`${groupFolder} ${session.backend}`, session),
  };
}

let store: ReturnType<typeof memoryStore>;
let events: ChatDisplayEvent[];
const collect = (event: ChatDisplayEvent) => {
  events.push(event);
};

beforeEach(() => {
  store = memoryStore();
  events = [];
});

describe('controller session lifecycle', () => {
  it('with no stored row: calls startOrResume, passes its empty native ref into runTurn, persists the result ref, reports "new"', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    expect(controller.status().state).toBe('new');
    expect(controller.status().sessionId).toBeUndefined();

    const outcome = await controller.runTurn('hello', OPTIONS, collect);
    expect(outcome.ok).toBe(true);
    expect(fake.startOrResumeCalls).toBe(1);
    // The empty ref goes to the runtime unchanged — the runtime mints the id.
    expect(fake.calls[0].sessionRef).toEqual({
      backend: 'deus-native',
      session_id: '',
    });
    // The minted id is persisted backend-scoped under the fixed identity.
    expect(store.get(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      MINTED_ID,
    );
    expect(controller.status().sessionId).toBe(MINTED_ID);
  });

  it('builds the RunContext with the fixed synthetic identity, the client cwd, stream:true, and no control-group privilege', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.runTurn('hello', OPTIONS, collect);

    const ctx = fake.calls[0].runContext;
    expect(ctx.groupFolder).toBe(CLI_CHAT_GROUP_FOLDER);
    expect(ctx.chatJid).toBe(CLI_CHAT_JID);
    expect(ctx.cwd).toBe(OPTIONS.cwd);
    expect(ctx.isControlGroup).toBe(false);
    expect(ctx.stream).toBe(true);
    // No permission profile is configured for this controller, so
    // backendConfig carries only the (mandatory since G2) model selection.
    expect(ctx.backendConfig).toEqual({ modelSelection: OPTIONS.models });
  });

  it('a second runTurn on the same controller reuses the first minted id', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.runTurn('one', OPTIONS, collect);
    await controller.runTurn('two', OPTIONS, collect);

    expect(fake.calls[1].sessionRef.session_id).toBe(MINTED_ID);
    // startOrResume was only needed for the first (row-less) turn.
    expect(fake.startOrResumeCalls).toBe(1);
  });

  it('a NEW controller over the same store loads the stored id and reports "resumed"', async () => {
    const fake1 = makeFakeRuntime();
    const controller1 = createDeusNativeChatController({
      runtime: fake1.runtime,
      sessions: store,
    });
    await controller1.start();
    await controller1.runTurn('one', OPTIONS, collect);

    const fake2 = makeFakeRuntime();
    const controller2 = createDeusNativeChatController({
      runtime: fake2.runtime,
      sessions: store,
    });
    await controller2.start();
    expect(controller2.status().state).toBe('resumed');
    expect(controller2.status().sessionId).toBe(MINTED_ID);

    await controller2.runTurn('three', OPTIONS, collect);
    expect(fake2.calls[0].sessionRef.session_id).toBe(MINTED_ID);
    expect(fake2.startOrResumeCalls).toBe(0);
  });

  it('persists via the mid-turn session EVENT path too', async () => {
    const fake = makeFakeRuntime({
      events: [
        [
          {
            type: 'session',
            sessionRef: { backend: 'deus-native', session_id: MINTED_ID },
          },
        ],
      ],
      // The result omits sessionRef so ONLY the event path can persist.
      results: [{ sessionRef: undefined }],
    });
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.runTurn('one', OPTIONS, collect);
    expect(store.get(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      MINTED_ID,
    );
    // Session events are internal — nothing is rendered for them.
    expect(events).toEqual([]);
  });

  it('rejects a foreign-backend or empty result ref instead of corrupting the native row', async () => {
    const fake = makeFakeRuntime({
      results: [
        { sessionRef: { backend: 'claude', session_id: 'claude-id' } },
        { sessionRef: { backend: 'deus-native', session_id: '' } },
      ],
    });
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    store.set(CLI_CHAT_GROUP_FOLDER, {
      backend: 'deus-native',
      session_id: MINTED_ID,
    });

    await controller.runTurn('one', OPTIONS, collect);
    await controller.runTurn('two', OPTIONS, collect);
    expect(store.get(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      MINTED_ID,
    );
  });

  it('on a runtime error result: emits one chat_error and does NOT replace a valid stored session', async () => {
    store.set(CLI_CHAT_GROUP_FOLDER, {
      backend: 'deus-native',
      session_id: MINTED_ID,
    });
    const fake = makeFakeRuntime({
      results: [
        {
          status: 'error',
          result: null,
          error: 'provider exploded',
          sessionRef: undefined,
        },
      ],
    });
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();

    const outcome = await controller.runTurn('one', OPTIONS, collect);
    expect(outcome.ok).toBe(false);
    expect(events).toEqual([
      { kind: 'chat_error', message: 'provider exploded' },
    ]);
    expect(store.get(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      MINTED_ID,
    );
  });

  it('close() calls the runtime with the current/persisted ref and never clears the store', async () => {
    store.set(CLI_CHAT_GROUP_FOLDER, {
      backend: 'deus-native',
      session_id: MINTED_ID,
    });
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.close();

    expect(fake.closed).toHaveLength(1);
    expect(fake.closed[0].session_id).toBe(MINTED_ID);
    expect(store.get(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      MINTED_ID,
    );
  });

  it('rejects a competing concurrent turn with NativeChatBusyError', async () => {
    let releaseTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const fake = makeFakeRuntime();
    const slowRunTurn = fake.runtime.runTurn.bind(fake.runtime);
    fake.runtime.runTurn = async (ctx, ref, sink) => {
      await gate;
      return slowRunTurn(ctx, ref, sink);
    };
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();

    const first = controller.runTurn('one', OPTIONS, collect);
    await expect(
      controller.runTurn('two', OPTIONS, collect),
    ).rejects.toBeInstanceOf(NativeChatBusyError);
    releaseTurn();
    await first;
  });

  it('refuses a non-deus-native runtime at construction', () => {
    const fake = makeFakeRuntime({ name: 'claude' });
    expect(() =>
      createDeusNativeChatController({
        runtime: fake.runtime,
        sessions: store,
      }),
    ).toThrow(/deus-native/);
  });
});

describe('plan-mode permission profile state', () => {
  it('starts in normal mode with an omitted profile displayed as default', async () => {
    const controller = createDeusNativeChatController({
      runtime: makeFakeRuntime().runtime,
      sessions: store,
    });
    await controller.start();

    expect(controller.status()).toMatchObject({
      mode: 'normal',
      permissionProfile: 'default',
    });
  });

  it('enables read-only, then restores the exact omitted permissionProfile representation', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();

    controller.setPlanMode(true);
    expect(controller.status()).toMatchObject({
      mode: 'plan',
      permissionProfile: 'read-only',
    });
    await controller.runTurn('plan', OPTIONS, collect);

    controller.setPlanMode(false);
    expect(controller.status()).toMatchObject({
      mode: 'normal',
      permissionProfile: 'default',
    });
    await controller.runTurn('normal', OPTIONS, collect);

    expect(fake.calls[0]?.runContext.backendConfig).toEqual({
      modelSelection: OPTIONS.models,
      permissionProfile: 'read-only',
    });
    // modelSelection (mandatory since G2) still rides along; the omitted
    // profile is represented by the absence of the permissionProfile key.
    expect(fake.calls[1]?.runContext.backendConfig).toEqual({
      modelSelection: OPTIONS.models,
    });
  });

  it('restores an explicit profile and repeated enable does not overwrite the snapshot', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
      configuredPermissionProfile: 'default',
    });
    await controller.start();

    controller.setPlanMode(true);
    controller.setPlanMode(true);
    await controller.runTurn('plan', OPTIONS, collect);
    controller.setPlanMode(false);
    controller.setPlanMode(false);
    await controller.runTurn('normal', OPTIONS, collect);

    expect(fake.calls.map((call) => call.runContext.backendConfig)).toEqual([
      { modelSelection: OPTIONS.models, permissionProfile: 'read-only' },
      { modelSelection: OPTIONS.models, permissionProfile: 'default' },
    ]);
  });

  it('reuses the same session id across mode transitions', async () => {
    const fake = makeFakeRuntime();
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();

    await controller.runTurn('normal before', OPTIONS, collect);
    controller.setPlanMode(true);
    await controller.runTurn('plan', OPTIONS, collect);
    controller.setPlanMode(false);
    await controller.runTurn('normal after', OPTIONS, collect);

    expect(fake.calls.map((call) => call.sessionRef.session_id)).toEqual([
      '',
      MINTED_ID,
      MINTED_ID,
    ]);
    expect(fake.startOrResumeCalls).toBe(1);
  });

  it('rejects an unknown explicitly configured profile at construction', () => {
    expect(() =>
      createDeusNativeChatController({
        runtime: makeFakeRuntime().runtime,
        sessions: store,
        configuredPermissionProfile: 'not-a-profile',
      }),
    ).toThrow(/unknown permission profile/);
  });
});

describe('runtime-event normalization (exhaustive)', () => {
  async function runWithEvents(
    runtimeEvents: RuntimeEvent[],
  ): Promise<ReturnType<typeof makeFakeRuntime> & { controller: unknown }> {
    const fake = makeFakeRuntime({ events: [runtimeEvents] });
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.runTurn('go', OPTIONS, collect);
    return { ...fake, controller };
  }

  it('output_text → assistant_text, preserving chunk boundaries', async () => {
    await runWithEvents([
      { type: 'output_text', text: 'Hello ' },
      { type: 'output_text', text: 'world' },
    ]);
    expect(events).toEqual([
      { kind: 'assistant_text', text: 'Hello ' },
      { kind: 'assistant_text', text: 'world' },
    ]);
  });

  it('activity → bounded progress line', async () => {
    await runWithEvents([{ type: 'activity', text: `${'x'.repeat(500)}` }]);
    expect(events).toHaveLength(1);
    const progress = events[0] as { kind: string; text: string };
    expect(progress.kind).toBe('progress');
    expect(progress.text.length).toBeLessThanOrEqual(200);
  });

  it('tool_call → compact bounded feedback, never raw argument JSON', async () => {
    await runWithEvents([
      {
        type: 'tool_call',
        name: 'web_search',
        arguments: {
          query: 'weather in berlin',
          api_token: 'SECRET-VALUE',
          nested: { blob: 'should never appear' },
        },
      },
    ]);
    expect(events).toHaveLength(1);
    const toolUse = events[0] as { kind: string; label: string };
    expect(toolUse.kind).toBe('tool_use');
    expect(toolUse.label).toContain('web_search');
    expect(toolUse.label).toContain('weather in berlin');
    expect(toolUse.label).not.toContain('SECRET-VALUE');
    expect(toolUse.label).not.toContain('should never appear');
    expect(toolUse.label).not.toContain('{');
  });

  it('turn_complete → assistant_done; error → sanitized chat_error', async () => {
    await runWithEvents([
      { type: 'turn_complete' },
      { type: 'error', error: 'boom' },
    ]);
    expect(events).toEqual([
      { kind: 'assistant_done' },
      { kind: 'chat_error', message: 'boom' },
    ]);
  });

  it('permission_request → bounded terminal-safe permission prompt data', async () => {
    await runWithEvents([
      {
        type: 'permission_request',
        requestId: 'permission-1',
        toolName: `web_search\u001b[31m${'x'.repeat(100)}`,
        toolInputPreview: `{"query":"${'y'.repeat(300)}"}\u001b[0m`,
        sessionId: MINTED_ID,
        requestedAt: '2026-07-21T00:00:00.000Z',
      },
    ]);

    expect(events).toHaveLength(1);
    const permission = events[0];
    expect(permission?.kind).toBe('permission_request');
    if (permission?.kind !== 'permission_request') return;
    expect(permission.requestId).toBe('permission-1');
    expect(permission.toolName.length).toBeLessThanOrEqual(60);
    expect(permission.toolInputPreview.length).toBeLessThanOrEqual(200);
    expect(permission.toolName).not.toContain('\u001b');
    expect(permission.toolInputPreview).not.toContain('\u001b');
  });

  it('usage is diagnostics-only: absent counts stay undefined, nothing rendered', async () => {
    const fake = makeFakeRuntime({
      events: [
        [
          {
            type: 'usage',
            sessionId: MINTED_ID,
            provider: 'anthropic',
            model: 'some-model',
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
          },
        ],
      ],
    });
    const controller = createDeusNativeChatController({
      runtime: fake.runtime,
      sessions: store,
    });
    await controller.start();
    await controller.runTurn('go', OPTIONS, collect);

    expect(events).toEqual([]);
    const usage = controller.status().usage;
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.totalTokens).toBeUndefined();
    expect(usage?.provider).toBe('anthropic');
  });

  it('status reports buffered vs streaming honestly from capabilities', async () => {
    const buffered = createDeusNativeChatController({
      runtime: makeFakeRuntime({ streaming: false }).runtime,
      sessions: store,
    });
    await buffered.start();
    expect(buffered.status().output).toBe('buffered');

    const streaming = createDeusNativeChatController({
      runtime: makeFakeRuntime({ streaming: true }).runtime,
      sessions: memoryStore(),
    });
    await streaming.start();
    expect(streaming.status().output).toBe('streaming');
  });
});

describe('formatToolUse', () => {
  it('caps and escapes the summary, strips control characters', () => {
    const label = formatToolUse('web_fetch', {
      url: `https://example.com/\u001b[31mred${'a'.repeat(300)}`,
    });
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label).not.toContain('\u001b');
  });

  it('falls back to a bare "Using name…" when no summarizable argument exists', () => {
    expect(formatToolUse('web_search', { payload: { deep: true } })).toBe(
      'Using web_search…',
    );
  });
});
