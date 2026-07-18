import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  agentInvoke: vi.fn(),
  createAgent: vi.fn(),
  createMcpBridge: vi.fn(),
  executeBrokerTool: vi.fn(),
  fetchMemoryContext: vi.fn(),
  chatAnthropicOptions: [] as Array<Record<string, unknown>>,
  anthropicOptions: [] as Array<Record<string, unknown>>,
  loadRuntimeSkillRegistry: vi.fn(),
  skillRegistry: {
    catalogContext: vi.fn(() => ''),
    resolvePrompt: vi.fn(() => null),
    load: vi.fn(),
  },
}));

vi.mock('langchain', () => ({
  createAgent: harness.createAgent,
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class FakeChatAnthropic {
    constructor(options: Record<string, unknown>) {
      harness.chatAnthropicOptions.push(options);
    }
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    constructor(options: Record<string, unknown>) {
      harness.anthropicOptions.push(options);
    }
  },
}));

vi.mock('./context-registry.js', () => ({
  loadRegisteredContextFiles: vi.fn(() => []),
}));

vi.mock('./memory-retrieval-hook.js', () => ({
  fetchMemoryContext: harness.fetchMemoryContext,
}));

vi.mock('./tool-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-broker.js')>();
  return {
    ...actual,
    createOpenAIMcpToolBridge: harness.createMcpBridge,
    executeBrokerTool: harness.executeBrokerTool,
  };
});

// Real filesystem discovery is irrelevant to this suite's concerns (backend
// wiring, not skill-loader internals — those are covered by
// skill-context-loader.test.ts). createSkillLoaderTool stays real (a pure
// factory over whatever registry it's given); only the registry itself is
// a controllable fake so each test can script catalogContext/resolvePrompt.
vi.mock('./skill-context-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./skill-context-loader.js')>();
  return {
    ...actual,
    loadRuntimeSkillRegistry: harness.loadRuntimeSkillRegistry,
  };
});

import { AIMessage } from '@langchain/core/messages';
import {
  DEUS_NATIVE_RECURSION_LIMIT,
  brokerDerivedToolNames,
  buildProxyRoutedModel,
  parseAnthropicCustomHeaders,
  runDeusNativeConversation,
} from './deus-native-backend.js';
import { getOpenAIToolDefinitions } from './tool-broker.js';
import type { ContainerInput, ContainerOutput } from './openai-backend.js';

const mcpDefinition = {
  type: 'function' as const,
  name: 'mcp__deus__ping',
  description: 'Ping the Deus MCP bridge',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

const baseInput: ContainerInput = {
  prompt: 'hello',
  backend: 'deus-native',
  groupFolder: 'test-group',
  chatJid: 'chat@test',
  isControlGroup: true,
};

function makeContext(overrides: Partial<ContainerInput> = {}) {
  const outputs: ContainerOutput[] = [];
  const waitForIpcMessage = vi.fn<() => Promise<string | null>>(
    async () => null,
  );
  return {
    outputs,
    waitForIpcMessage,
    ctx: {
      containerInput: { ...baseInput, ...overrides },
      log: vi.fn(),
      writeOutput: (output: ContainerOutput) => outputs.push(output),
      drainIpcInput: vi.fn(() => [] as string[]),
      waitForIpcMessage,
      shouldClose: vi.fn(() => false),
    },
  };
}

describe('container deus-native driver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.chatAnthropicOptions.length = 0;
    harness.anthropicOptions.length = 0;
    process.env.ANTHROPIC_BASE_URL = 'http://credential-proxy:3001';
    process.env.DEUS_PROXY_TOKEN = 'proxy-token';
    process.env.ANTHROPIC_API_KEY = 'placeholder';
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.DEUS_TOOL_PROFILE;

    harness.fetchMemoryContext.mockResolvedValue('');
    harness.executeBrokerTool.mockResolvedValue({ ok: true });
    harness.createMcpBridge.mockResolvedValue({
      definitions: [mcpDefinition],
      execute: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    });
    harness.agentInvoke.mockImplementation(async ({ messages }) => ({
      messages: [...messages, new AIMessage('native answer')],
    }));
    harness.createAgent.mockReturnValue({ invoke: harness.agentInvoke });

    harness.skillRegistry.catalogContext.mockReturnValue('');
    harness.skillRegistry.resolvePrompt.mockReturnValue(null);
    harness.skillRegistry.load.mockReset();
    harness.loadRuntimeSkillRegistry.mockReturnValue(harness.skillRegistry);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.DEUS_PROXY_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.DEUS_TOOL_PROFILE;
    delete process.env.DEUS_NATIVE_MODEL;
  });

  it('parses forwarded custom headers and routes the Anthropic client through the proxy', () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS =
      'x-extra: retained\nx-deus-proxy-token: stale';
    buildProxyRoutedModel();

    expect(parseAnthropicCustomHeaders('X-Test: one\ninvalid')).toEqual({
      'x-test': 'one',
    });
    const createClient = harness.chatAnthropicOptions[0].createClient as (
      options: Record<string, unknown>,
    ) => unknown;
    createClient({});
    expect(harness.anthropicOptions[0]).toMatchObject({
      baseURL: 'http://credential-proxy:3001',
      apiKey: 'placeholder',
      defaultHeaders: {
        'x-extra': 'retained',
        'x-deus-proxy-token': 'proxy-token',
      },
    });
  });

  it('uses placeholder OAuth credentials and preserves proxy auth in OAuth mode', () => {
    delete process.env.ANTHROPIC_API_KEY;
    buildProxyRoutedModel();

    const createClient = harness.chatAnthropicOptions[0].createClient as (
      options: Record<string, unknown>,
    ) => unknown;
    createClient({});
    expect(harness.anthropicOptions[0]).toMatchObject({
      baseURL: 'http://credential-proxy:3001',
      authToken: 'placeholder',
      apiKey: null,
      defaultHeaders: {
        'anthropic-beta': 'oauth-2025-04-20',
        'x-deus-proxy-token': 'proxy-token',
      },
    });
  });

  it('binds createAgent only to broker/MCP-derived tools plus the one permitted load_skill resolver, and pins recursion', async () => {
    const { ctx, outputs } = makeContext({ isScheduledTask: true });
    await runDeusNativeConversation(ctx);

    const definitions = getOpenAIToolDefinitions([mcpDefinition]);
    const allowedNames = brokerDerivedToolNames([mcpDefinition]);
    const createArgs = harness.createAgent.mock.calls[0][0] as {
      tools: Array<{ name: string }>;
    };
    const boundNames = createArgs.tools.map((boundTool) => boundTool.name);
    const nonBrokerNames = boundNames.filter((name) => !allowedNames.has(name));

    // LIA-426/F4: exactly one non-broker tool is ever permitted — the local,
    // read-only skill instruction resolver. Any other non-broker name here
    // would be a real security regression.
    expect(nonBrokerNames).toEqual(['load_skill']);
    expect(boundNames).toHaveLength(definitions.length + 1);
    expect(boundNames).not.toContain('shell');
    expect(boundNames).not.toContain('python');
    expect(harness.agentInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ messages: expect.any(Array) }),
      { recursionLimit: DEUS_NATIVE_RECURSION_LIMIT },
    );
    expect(outputs[0]).toMatchObject({
      status: 'success',
      result: 'native answer',
      newSessionRef: { backend: 'deus-native' },
    });
    expect(outputs[1]).toMatchObject({ status: 'success', result: null });
  });

  it('refuses webhook-profile requests before any MCP, model, or agent initialization', async () => {
    process.env.DEUS_TOOL_PROFILE = 'webhook';
    const { ctx, outputs } = makeContext();
    await runDeusNativeConversation(ctx);

    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'error',
        result: null,
        error: expect.stringContaining('refusing deus-native before model'),
      }),
    ]);
    expect(harness.createMcpBridge).not.toHaveBeenCalled();
    expect(harness.createAgent).not.toHaveBeenCalled();
    expect(harness.chatAnthropicOptions).toHaveLength(0);
    // LIA-426/F4: skill discovery must not happen before the webhook refusal
    // either — refusal is unconditional and precedes ALL initialization.
    expect(harness.loadRuntimeSkillRegistry).not.toHaveBeenCalled();
  });

  it('preserves native session metadata across IPC follow-up turns', async () => {
    harness.agentInvoke
      .mockImplementationOnce(async ({ messages }) => ({
        messages: [...messages, new AIMessage('first answer')],
      }))
      .mockImplementationOnce(async ({ messages }) => ({
        messages: [...messages, new AIMessage('second answer')],
      }));
    const { ctx, outputs, waitForIpcMessage } = makeContext({
      sessionRef: {
        backend: 'deus-native',
        session_id: 'native-session',
        resume_cursor: 'cursor-1',
        metadata_json: '{"key":"value"}',
      },
    });
    waitForIpcMessage
      .mockResolvedValueOnce('follow up')
      .mockResolvedValueOnce(null);

    await runDeusNativeConversation(ctx);

    expect(harness.agentInvoke).toHaveBeenCalledTimes(2);
    expect(outputs.filter((output) => output.result !== null)).toMatchObject([
      { result: 'first answer' },
      { result: 'second answer' },
    ]);
    for (const output of outputs) {
      expect(output.newSessionId).toBe('native-session');
      expect(output.newSessionRef).toEqual({
        backend: 'deus-native',
        session_id: 'native-session',
        resume_cursor: 'cursor-1',
        metadata_json: '{"key":"value"}',
      });
    }
  });

  it('converts agent failures into a terminal error and closes MCP', async () => {
    const close = vi.fn(async () => undefined);
    harness.createMcpBridge.mockResolvedValue({
      definitions: [mcpDefinition],
      execute: vi.fn(async () => null),
      close,
    });
    harness.agentInvoke.mockRejectedValue(new Error('model failed'));
    const { ctx, outputs } = makeContext();

    await expect(runDeusNativeConversation(ctx)).resolves.toBeUndefined();

    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'error',
        result: null,
        error: 'model failed',
        newSessionRef: expect.objectContaining({ backend: 'deus-native' }),
      }),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('deus-native driver — skill loading (LIA-426/F4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.chatAnthropicOptions.length = 0;
    harness.anthropicOptions.length = 0;
    process.env.ANTHROPIC_BASE_URL = 'http://credential-proxy:3001';
    process.env.DEUS_PROXY_TOKEN = 'proxy-token';
    process.env.ANTHROPIC_API_KEY = 'placeholder';
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.DEUS_TOOL_PROFILE;

    harness.fetchMemoryContext.mockResolvedValue('');
    harness.executeBrokerTool.mockResolvedValue({ ok: true });
    harness.createMcpBridge.mockResolvedValue({
      definitions: [mcpDefinition],
      execute: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    });
    harness.agentInvoke.mockImplementation(async ({ messages }) => ({
      messages: [...messages, new AIMessage('native answer')],
    }));
    harness.createAgent.mockReturnValue({ invoke: harness.agentInvoke });

    harness.skillRegistry.catalogContext.mockReturnValue('');
    harness.skillRegistry.resolvePrompt.mockReturnValue(null);
    harness.skillRegistry.load.mockReset();
    harness.loadRuntimeSkillRegistry.mockReturnValue(harness.skillRegistry);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.DEUS_PROXY_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.DEUS_TOOL_PROFILE;
  });

  it('appends the skill catalog (descriptions only) to the system prompt, not full bodies', async () => {
    harness.skillRegistry.catalogContext.mockReturnValue(
      '=== AVAILABLE SKILLS ===\n- /status: Quick health check',
    );
    const { ctx } = makeContext({ isScheduledTask: true });
    await runDeusNativeConversation(ctx);

    const createArgs = harness.createAgent.mock.calls[0][0] as {
      systemPrompt: string;
    };
    expect(createArgs.systemPrompt).toContain('/status: Quick health check');
    // The catalog entry is a one-line description — confirm no multi-line
    // skill BODY content leaked in via some other path.
    expect(createArgs.systemPrompt.split('\n').length).toBeLessThan(20);
  });

  it('binds exactly one load_skill tool wired to registry.load with invoker "model"', async () => {
    harness.skillRegistry.load.mockReturnValue({
      ok: true,
      name: 'status',
      contextBlock: '=== SKILL: status ===\nBODY',
    });
    const { ctx } = makeContext({ isScheduledTask: true });
    await runDeusNativeConversation(ctx);

    const createArgs = harness.createAgent.mock.calls[0][0] as {
      tools: Array<{
        name: string;
        invoke: (input: unknown) => Promise<unknown>;
      }>;
    };
    const loaderTools = createArgs.tools.filter((t) => t.name === 'load_skill');
    expect(loaderTools).toHaveLength(1);

    const raw = await loaderTools[0].invoke({ name: 'status' });
    expect(harness.skillRegistry.load).toHaveBeenCalledWith(
      'status',
      '',
      'model',
    );
    expect(JSON.parse(raw as string)).toMatchObject({
      ok: true,
      name: 'status',
    });
  });

  it('a direct invocation prepends the resolved skill body to the turn, preserving the original prompt', async () => {
    harness.skillRegistry.resolvePrompt.mockReturnValue({
      ok: true,
      name: 'status',
      contextBlock: '=== SKILL: status ===\nDo the status check.',
    });
    const { ctx } = makeContext({ prompt: '/status', isScheduledTask: true });
    await runDeusNativeConversation(ctx);

    const invokeArgs = harness.agentInvoke.mock.calls[0][0] as {
      messages: Array<{ content: unknown }>;
    };
    const lastMessage = invokeArgs.messages[invokeArgs.messages.length - 1];
    const text = Array.isArray(lastMessage.content)
      ? (lastMessage.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
      : String(lastMessage.content);
    expect(text).toContain('Do the status check.');
    expect(text).toContain('/status');
  });

  it('a missing/invalid direct invocation produces an actionable handled result (status: success), then a subsequent turn succeeds with the same session ref', async () => {
    harness.skillRegistry.resolvePrompt.mockReturnValueOnce({
      ok: false,
      code: 'not-found',
      message: 'Skill "/missing" is not available. Available: status.',
    });
    const waitForIpcMessage = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('a normal follow-up message')
      .mockResolvedValueOnce(null);
    const { ctx, outputs } = makeContext({ prompt: '/missing' });
    ctx.waitForIpcMessage = waitForIpcMessage;

    await runDeusNativeConversation(ctx);

    // First turn: handled failure, never a transport-level error.
    expect(outputs[0]).toMatchObject({
      status: 'success',
      result: expect.stringContaining('Skill "/missing" is not available'),
    });
    const firstSessionRef = (
      outputs[0] as { newSessionRef: { session_id: string } }
    ).newSessionRef;
    // Second turn (the follow-up IPC message): a normal successful turn,
    // same session reference — proves the failure didn't corrupt state.
    const secondTurnOutput = outputs.find(
      (o) => o.status === 'success' && o.result === 'native answer',
    );
    expect(secondTurnOutput).toBeDefined();
    // The agent was invoked exactly once, for the follow-up turn only —
    // never for the failed direct-invocation turn.
    expect(harness.agentInvoke).toHaveBeenCalledTimes(1);
    expect(harness.agentInvoke.mock.calls[0][0]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ text: 'a normal follow-up message' }),
          ]),
        }),
      ]),
    });
    expect(
      (secondTurnOutput as { newSessionRef: { session_id: string } })
        .newSessionRef.session_id,
    ).toBe(firstSessionRef.session_id);
  });
});
