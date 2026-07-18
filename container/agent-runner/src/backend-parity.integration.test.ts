import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createAgent: vi.fn(),
  agentInvoke: vi.fn(),
  createMcpBridge: vi.fn(),
}));

vi.mock('./bootstrap.js', () => ({ bootstrap: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('langchain', () => ({ createAgent: mocks.createAgent }));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class FakeChatAnthropic {},
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {},
}));
vi.mock('./context-registry.js', () => ({
  loadRegisteredContextFiles: vi.fn(() => []),
}));
vi.mock('./memory-retrieval-hook.js', () => ({
  fetchMemoryContext: vi.fn(async () => ''),
  createMemoryRetrievalHook: vi.fn(() => async () => ({})),
}));
vi.mock('./tool-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-broker.js')>();
  return {
    ...actual,
    createOpenAIMcpToolBridge: mocks.createMcpBridge,
  };
});

import { AIMessage } from '@langchain/core/messages';
import { ContainerOutputSchema } from '../../../src/ipc-protocol.js';
import { runDeusNativeConversation } from './deus-native-backend.js';
import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  runQuery,
  writeOutput,
} from './index.js';

function capturedFrames(lines: string[]): unknown[] {
  const frames: unknown[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== OUTPUT_START_MARKER) continue;
    expect(lines[i + 2]).toBe(OUTPUT_END_MARKER);
    frames.push(JSON.parse(lines[i + 1]));
    i += 2;
  }
  return frames;
}

describe('Claude/deus-native container protocol parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_BASE_URL = 'http://credential-proxy:3001';
    process.env.DEUS_PROXY_TOKEN = 'proxy-token';
    process.env.ANTHROPIC_API_KEY = 'placeholder';
    delete process.env.DEUS_TOOL_PROFILE;

    mocks.query.mockImplementation(async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session',
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'equivalent answer',
        session_id: 'claude-session',
        usage: {
          input_tokens: 2,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          model: {
            inputTokens: 2,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
      };
    });
    mocks.agentInvoke.mockImplementation(async ({ messages }) => ({
      messages: [...messages, new AIMessage('equivalent answer')],
    }));
    mocks.createAgent.mockReturnValue({ invoke: mocks.agentInvoke });
    mocks.createMcpBridge.mockResolvedValue({
      definitions: [],
      execute: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    });
  });

  it('emits schema-valid marked success frames for equivalent basic turns', async () => {
    const lines: string[] = [];
    const stdout = vi
      .spyOn(console, 'log')
      .mockImplementation((value) => lines.push(String(value)));

    await runQuery(
      'hello',
      undefined,
      '/tmp/ipc-mcp-stdio.js',
      {
        prompt: 'hello',
        backend: 'claude',
        groupFolder: 'test-group',
        chatJid: 'chat@test',
        isScheduledTask: true,
      },
      {},
    );
    const claudeFrames = capturedFrames(lines);
    lines.length = 0;

    await runDeusNativeConversation({
      containerInput: {
        prompt: 'hello',
        backend: 'deus-native',
        groupFolder: 'test-group',
        chatJid: 'chat@test',
        isScheduledTask: true,
      },
      log: vi.fn(),
      writeOutput,
      drainIpcInput: () => [],
      waitForIpcMessage: async () => null,
      shouldClose: () => false,
    });
    const nativeFrames = capturedFrames(lines);
    stdout.mockRestore();

    const claudeTerminal = ContainerOutputSchema.parse(claudeFrames[0]);
    const nativeTerminal = ContainerOutputSchema.parse(nativeFrames[0]);

    for (const terminal of [claudeTerminal, nativeTerminal]) {
      expect(terminal.status).toBe('success');
      expect(terminal.result).toBe('equivalent answer');
      expect(terminal.newSessionId).toBeTruthy();
      expect(terminal.newSessionRef?.session_id).toBe(terminal.newSessionId);
    }
    expect(claudeTerminal.newSessionRef?.backend).toBe('claude');
    expect(nativeTerminal.newSessionRef?.backend).toBe('deus-native');
    expect(
      nativeFrames.map((frame) => ContainerOutputSchema.parse(frame)),
    ).toHaveLength(2);
  });

  // LIA-426/F4: uses the REAL container/skills/status/SKILL.md content (read
  // from the repo, not a fixture string) — /status is the best representative
  // skill because it is container-native, read-only, deterministic, needs no
  // external credentials, and exercises real instruction-pack discovery +
  // rendering end to end. The production personal skill root
  // (/home/node/.claude/skills) only exists inside the built container image,
  // so fs is spied here to simulate that mount pointing at this real file,
  // rather than requiring the actual container filesystem to run this test.
  it('injects the real /status skill body into the turn for a deus-native direct invocation', async () => {
    const realStatusSkill = fs.readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '..',
        'skills',
        'status',
        'SKILL.md',
      ),
      'utf-8',
    );
    const personalRoot = '/home/node/.claude/skills';
    const statusDir = path.join(personalRoot, 'status');
    const statusFile = path.join(statusDir, 'SKILL.md');

    const existsSpy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => p === personalRoot || p === statusFile);
    const readdirSpy = vi
      .spyOn(fs, 'readdirSync')
      .mockImplementation(
        (p) => (p === personalRoot ? ['status'] : []) as never,
      );
    const statSpy = vi
      .spyOn(fs, 'statSync')
      .mockImplementation(
        () => ({ isDirectory: () => true }) as unknown as fs.Stats,
      );
    const readFileSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((p, enc) => {
        if (p === statusFile) return realStatusSkill;
        throw new Error(`unexpected readFileSync call in test: ${String(p)}`);
      });

    let capturedMessages: unknown[] = [];
    mocks.agentInvoke.mockImplementation(async ({ messages }) => {
      capturedMessages = messages;
      return { messages: [...messages, new AIMessage('status report')] };
    });

    try {
      const lines: string[] = [];
      const stdout = vi
        .spyOn(console, 'log')
        .mockImplementation((value) => lines.push(String(value)));

      // isScheduledTask: true — proves direct skill invocation also matches
      // a scheduled task whose literal configured body IS a command (e.g. a
      // nightly "/compress" cron entry). The scheduled-task banner is
      // decoupled from command detection precisely so this case works.
      await runDeusNativeConversation({
        containerInput: {
          prompt: '/status',
          backend: 'deus-native',
          groupFolder: 'test-group',
          chatJid: 'chat@test',
          isScheduledTask: true,
        },
        log: vi.fn(),
        writeOutput,
        drainIpcInput: () => [],
        waitForIpcMessage: async () => null,
        shouldClose: () => false,
      });
      const frames = capturedFrames(lines);
      stdout.mockRestore();

      const terminal = ContainerOutputSchema.parse(frames[0]);
      expect(terminal.status).toBe('success');

      const lastMessage = capturedMessages[capturedMessages.length - 1] as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = lastMessage.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      // Real content from the actual SKILL.md's own "Report format" section
      // (not its gather-instructions text) — proves the real file's body
      // drove this turn, not a generic fallback.
      expect(text).toContain('Deus Status');
      expect(text).toContain('/status');
    } finally {
      existsSpy.mockRestore();
      readdirSpy.mockRestore();
      statSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });
});
