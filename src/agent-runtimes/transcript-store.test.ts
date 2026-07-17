import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { STORE_DIR } from '../config.js';
import { IS_WINDOWS } from '../platform.js';
import {
  appendDeusNativeTranscriptTurn,
  resolveDeusNativeTranscriptPath,
  resolveDeusNativeTranscriptRoot,
  type TranscriptTurnInput,
} from './transcript-store.js';

const SESSION_HASH =
  '0f85dde759830a939f71595b9461cc8731f7323758d5827e7ea550ab34baf02b';
const temporaryRoots: string[] = [];

interface ParsedRecord extends Record<string, unknown> {
  type?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  turnId?: string;
  message: Record<string, unknown>;
  deusNative: Record<string, unknown>;
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-transcript-test-'));
  temporaryRoots.push(root);
  return root;
}

function turn(
  overrides: Partial<TranscriptTurnInput> = {},
): TranscriptTurnInput {
  return {
    sessionId: 'native-session-001',
    groupFolder: 'whatsapp_main',
    cwd: '/absolute/project/path',
    prompt: 'Find the relevant source and explain it.',
    assistantText: 'Here is the source and explanation.',
    userMessageId: 'user-message-uuid',
    assistantMessageId: 'assistant-message-id',
    primaryModel: 'claude-sonnet-4-5',
    toolCalls: [],
    usageEvents: [],
    startedAt: new Date('2026-07-17T12:00:00.000Z'),
    completedAt: new Date('2026-07-17T12:00:02.000Z'),
    ...overrides,
  };
}

function parseLines(filePath: string): ParsedRecord[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  expect(raw.endsWith('\n')).toBe(true);
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ParsedRecord);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('transcript path resolvers', () => {
  it('uses the real STORE_DIR and known SHA-256 session filename by default', () => {
    expect(resolveDeusNativeTranscriptPath('native-session-001')).toBe(
      path.join(
        STORE_DIR,
        'transcripts',
        'deus-native',
        `${SESSION_HASH}.jsonl`,
      ),
    );
  });

  it('keeps the exact default relative layout under a test root override', () => {
    const override = temporaryRoot();
    const defaultPath = resolveDeusNativeTranscriptPath('native-session-001');
    const overridePath = resolveDeusNativeTranscriptPath('native-session-001', {
      rootDir: override,
    });
    expect(path.relative(STORE_DIR, defaultPath)).toBe(
      path.relative(override, overridePath),
    );
  });

  it('rejects an empty session id before hashing', () => {
    expect(() => resolveDeusNativeTranscriptPath('')).toThrow(
      'session id must not be empty',
    );
  });
});

describe('transcript directory ownership and permissions', () => {
  it('creates the complete store/transcripts/deus-native tree itself', async () => {
    const rootDir = path.join(temporaryRoot(), 'missing-store');
    expect(fs.existsSync(rootDir)).toBe(false);

    const result = await appendDeusNativeTranscriptTurn(turn(), { rootDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(fs.statSync(result.path).isFile()).toBe(true);
    expect(
      fs.statSync(resolveDeusNativeTranscriptRoot(rootDir)).isDirectory(),
    ).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('sets and verifies POSIX 0700/0600 modes', async () => {
    const rootDir = temporaryRoot();
    const result = await appendDeusNativeTranscriptTurn(turn(), { rootDir });
    if (!result.ok) throw result.error;

    expect(
      fs.statSync(resolveDeusNativeTranscriptRoot(rootDir)).mode & 0o777,
    ).toBe(0o700);
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);

    fs.chmodSync(resolveDeusNativeTranscriptRoot(rootDir), 0o755);
    fs.chmodSync(result.path, 0o644);
    const second = await appendDeusNativeTranscriptTurn(
      turn({ userMessageId: 'second-user' }),
      { rootDir },
    );
    if (!second.ok) throw second.error;
    expect(
      fs.statSync(resolveDeusNativeTranscriptRoot(rootDir)).mode & 0o777,
    ).toBe(0o700);
    expect(fs.statSync(second.path).mode & 0o777).toBe(0o600);
  });
});

describe('JSONL schema v1 serialization', () => {
  it('writes exactly user then assistant with shared ids and a trailing newline', async () => {
    const rootDir = temporaryRoot();
    const result = await appendDeusNativeTranscriptTurn(turn(), { rootDir });
    if (!result.ok) throw result.error;
    const [user, assistant] = parseLines(result.path);

    expect(user).toMatchObject({
      schemaVersion: 1,
      source: 'deus-native',
      type: 'user',
      sessionId: 'native-session-001',
      uuid: 'user-message-uuid',
      timestamp: '2026-07-17T12:00:00.000Z',
      cwd: '/absolute/project/path',
      groupFolder: 'whatsapp_main',
      role: 'user',
      message: {
        id: 'user-message-uuid',
        role: 'user',
        content: 'Find the relevant source and explain it.',
      },
      deusNative: {
        backend: 'deus-native',
        schema: 'deus-native-transcript-v1',
      },
    });
    expect(assistant).toMatchObject({
      schemaVersion: 1,
      source: 'deus-native',
      type: 'assistant',
      sessionId: 'native-session-001',
      uuid: 'assistant-message-id',
      parentUuid: 'user-message-uuid',
      timestamp: '2026-07-17T12:00:02.000Z',
      groupFolder: 'whatsapp_main',
      role: 'assistant',
      message: {
        id: 'assistant-message-id',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Here is the source and explanation.' },
        ],
        stop_reason: 'end_turn',
      },
    });
    expect(user.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(assistant.turnId).toBe(user.turnId);
  });

  it('omits cwd instead of substituting an unrelated path', async () => {
    const result = await appendDeusNativeTranscriptTurn(
      turn({ cwd: undefined }),
      { rootDir: temporaryRoot() },
    );
    if (!result.ok) throw result.error;
    for (const record of parseLines(result.path)) {
      expect(record).not.toHaveProperty('cwd');
    }
  });

  it('projects final text and ordered JSON-safe tool calls without tool results', async () => {
    const result = await appendDeusNativeTranscriptTurn(
      turn({
        toolCalls: [
          { id: 'call-1', name: 'web_search', input: { query: 'source' } },
          { name: 'web_fetch', input: { url: 'https://example.com' } },
        ],
      }),
      { rootDir: temporaryRoot() },
    );
    if (!result.ok) throw result.error;
    const assistant = parseLines(result.path)[1];

    expect(assistant.message.content).toEqual([
      { type: 'text', text: 'Here is the source and explanation.' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'web_search',
        input: { query: 'source' },
      },
      {
        type: 'tool_use',
        name: 'web_fetch',
        input: { url: 'https://example.com' },
      },
    ]);
    expect(assistant.deusNative.toolCalls).toEqual([
      { id: 'call-1', name: 'web_search' },
      { name: 'web_fetch' },
    ]);
    expect(JSON.stringify(assistant)).not.toContain('tool_result');
  });
});

describe('usage serialization', () => {
  it('keeps ordered multi-model events authoritative and omits compatibility usage', async () => {
    const usageEvents = [
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      },
    ];
    const result = await appendDeusNativeTranscriptTurn(turn({ usageEvents }), {
      rootDir: temporaryRoot(),
    });
    if (!result.ok) throw result.error;
    const assistant = parseLines(result.path)[1];

    expect(assistant.deusNative.usage).toEqual(usageEvents);
    expect(assistant.message).not.toHaveProperty('usage');
    const raw = JSON.stringify(assistant);
    for (const forbidden of [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'provenance',
      'nested',
      'main',
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  it('adds only input/output/total compatibility fields for one complete event', async () => {
    const result = await appendDeusNativeTranscriptTurn(
      turn({
        usageEvents: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
          },
        ],
      }),
      { rootDir: temporaryRoot() },
    );
    if (!result.ok) throw result.error;
    const usage = parseLines(result.path)[1].message.usage as Record<
      string,
      number
    >;
    expect(usage).toEqual({
      input_tokens: 80,
      output_tokens: 20,
      total_tokens: 100,
    });
    expect(Object.keys(usage).sort()).toEqual([
      'input_tokens',
      'output_tokens',
      'total_tokens',
    ]);
  });

  it('preserves undefined token fields as absent and never fabricates zero', async () => {
    const result = await appendDeusNativeTranscriptTurn(
      turn({
        usageEvents: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            outputTokens: 9,
          },
        ],
      }),
      { rootDir: temporaryRoot() },
    );
    if (!result.ok) throw result.error;
    const assistant = parseLines(result.path)[1];
    expect(assistant.deusNative.usage).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        outputTokens: 9,
      },
    ]);
    expect(assistant.message).not.toHaveProperty('usage');
    expect(JSON.stringify(assistant.deusNative.usage)).not.toContain(':0');
  });
});

describe('append and queue behavior', () => {
  it('appends a second pair without changing the first payload bytes', async () => {
    const rootDir = temporaryRoot();
    const first = await appendDeusNativeTranscriptTurn(turn(), { rootDir });
    if (!first.ok) throw first.error;
    const firstBytes = fs.readFileSync(first.path);

    const second = await appendDeusNativeTranscriptTurn(
      turn({
        userMessageId: 'user-2',
        assistantMessageId: 'assistant-2',
        prompt: 'Second prompt.',
      }),
      { rootDir },
    );
    if (!second.ok) throw second.error;
    const combined = fs.readFileSync(second.path);

    expect(combined.subarray(0, firstBytes.length).equals(firstBytes)).toBe(
      true,
    );
    expect(parseLines(second.path)).toHaveLength(4);
  });

  it('isolates a malformed trailing line before appending the next valid pair', async () => {
    const rootDir = temporaryRoot();
    const transcriptPath = resolveDeusNativeTranscriptPath(
      'native-session-001',
      { rootDir },
    );
    const malformedLine =
      '{"schemaVersion":1,"source":"deus-native","type":"user"';
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, malformedLine);

    const result = await appendDeusNativeTranscriptTurn(turn(), { rootDir });
    if (!result.ok) throw result.error;

    const lines = fs.readFileSync(result.path, 'utf8').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(malformedLine);
    expect(() => JSON.parse(lines[0])).toThrow();
    const user = JSON.parse(lines[1]) as ParsedRecord;
    const assistant = JSON.parse(lines[2]) as ParsedRecord;
    expect(user.type).toBe('user');
    expect(assistant.type).toBe('assistant');
    expect(assistant.turnId).toBe(user.turnId);
    expect(lines[3]).toBe('');
  });

  it('keeps every concurrent same-session user/assistant pair contiguous', async () => {
    const rootDir = temporaryRoot();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendDeusNativeTranscriptTurn(
          turn({
            userMessageId: `user-${index}`,
            assistantMessageId: `assistant-${index}`,
            prompt: `Prompt ${index}`,
          }),
          { rootDir },
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const first = results[0];
    if (!first.ok) throw first.error;
    const records = parseLines(first.path);
    expect(records).toHaveLength(24);
    const observed = new Set<string>();
    for (let index = 0; index < records.length; index += 2) {
      const user = records[index];
      const assistant = records[index + 1];
      expect(user.type).toBe('user');
      expect(assistant.type).toBe('assistant');
      expect(assistant.turnId).toBe(user.turnId);
      expect(assistant.parentUuid).toBe(user.uuid);
      expect(typeof user.uuid).toBe('string');
      observed.add(user.uuid as string);
    }
    expect(observed).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => `user-${index}`)),
    );
  });

  it('never places unsafe session-id characters in the filename', async () => {
    const sessionId = '../unsafe/..\\unicode-שלום $(touch nope)';
    const result = await appendDeusNativeTranscriptTurn(turn({ sessionId }), {
      rootDir: temporaryRoot(),
    });
    if (!result.ok) throw result.error;

    expect(path.basename(result.path)).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    for (const record of parseLines(result.path)) {
      expect(record.sessionId).toBe(sessionId);
    }
  });
});

describe('fail-soft persistence', () => {
  it('returns ok:false, warns with redacted context, and never throws', async () => {
    const rootDir = temporaryRoot();
    const regularFile = path.join(rootDir, 'occupied');
    fs.writeFileSync(regularFile, 'do not replace');
    const warn = vi.fn();
    const prompt = 'SECRET-PROMPT-CONTENT';
    const assistantText = 'SECRET-ASSISTANT-CONTENT';
    const secretArgument = 'SECRET-TOOL-ARGUMENT';

    const result = await appendDeusNativeTranscriptTurn(
      turn({
        prompt,
        assistantText,
        toolCalls: [{ name: 'web_search', input: { query: secretArgument } }],
      }),
      { rootDir: regularFile, warn },
    );

    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const warningMaterial = warn.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(' ');
    expect(warningMaterial).not.toContain(prompt);
    expect(warningMaterial).not.toContain(assistantText);
    expect(warningMaterial).not.toContain(secretArgument);
    expect(fs.readFileSync(regularFile, 'utf8')).toBe('do not replace');
  });
});
