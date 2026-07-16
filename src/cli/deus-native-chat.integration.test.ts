/**
 * LIA-428 / G1 and LIA-430 / G3 end-to-end integration: real ephemeral chat server + real
 * DeusNativeRuntime + real LangGraph engine over a REAL SqliteSaver temp
 * file, with the scripted FakeToolCallingModel — the same hermetic harness
 * deus-native-checkpointer-integration.test.ts established (a mocked
 * createAgent would make the checkpointer/session assertions meaningless).
 * Session rows live in the real db layer via _initTestDatabase (in-memory).
 * No live provider or non-loopback network calls.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tool, FakeToolCallingModel } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

import { _initTestDatabase, getSession } from '../db.js';
import { getCheckpointer } from '../agent-runtimes/checkpointer.js';
import type { ContainerRuntimeDeps } from '../agent-runtimes/container-backend.js';
import {
  CLI_CHAT_GROUP_FOLDER,
  parseDiscoveryRecord,
} from './deus-native-chat.js';

// ---------------------------------------------------------------------------
// Hoisted harness + module mocks — the established cross-module convention
// from deus-native-checkpointer-integration.test.ts.
// ---------------------------------------------------------------------------
const harness = vi.hoisted(() => ({
  groupsDir: '',
  checkpointerDbPath: '',
  makeModel: null as null | (() => unknown),
  tools: [] as unknown[],
  captured: [] as Array<{ messages: unknown[] }>,
}));

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  const capture = actual.createMiddleware({
    name: 'g3-test-capture',
    wrapModelCall: (request, handler) => {
      harness.captured.push({ messages: [...request.messages] });
      return handler(request);
    },
  });
  return {
    ...actual,
    createAgent: (config: Parameters<typeof actual.createAgent>[0]) =>
      actual.createAgent({
        ...config,
        model: harness.makeModel
          ? (harness.makeModel() as typeof config.model)
          : config.model,
        middleware: [
          ...(config.middleware ?? []),
          capture,
        ] as typeof config.middleware,
      }),
  };
});

vi.mock('../agent-runtimes/checkpointer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../agent-runtimes/checkpointer.js')>();
  return {
    ...actual,
    getCheckpointer: () => actual.getCheckpointer(harness.checkpointerDbPath),
  };
});

vi.mock('../group-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../group-folder.js')>();
  const nodePath = await import('path');
  return {
    ...actual,
    resolveGroupFolderPath: (folder: string) =>
      nodePath.join(harness.groupsDir, folder),
  };
});

vi.mock('../credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key' as const,
}));
vi.mock('../group-tokens.js', () => ({
  getOrCreateGroupToken: () => 'fake-proxy-token',
}));
vi.mock('../agent-runtimes/tool-broker-langchain-adapter.js', () => ({
  buildSafeTools: async () => harness.tools,
}));

const { createDeusNativeRuntime } =
  await import('../agent-runtimes/deus-native-backend.js');
const { _resetCheckpointerForTests } =
  await import('../agent-runtimes/checkpointer.js');
const { startNativeChatServer, createDbSessionStore } =
  await import('./deus-native-chat-server.js');
const { createHttpChatTransport, runChatCli } =
  await import('./deus-native-chat-client.js');

const stubDeps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => {},
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ECHO_TOOL = tool(
  async (args: { value: string }) => `echo:${args.value}`,
  {
    name: 'echo_tool',
    description: 'Echoes the provided value back.',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
);

function answerOnlyModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({ toolCalls: [[]] });
}

function toolCallThenAnswerModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({
    toolCalls: [
      [{ name: 'echo_tool', args: { value: 'ping' }, id: 'call_1' }],
      [],
    ],
  });
}

/**
 * Give every response from LangChain's tool-calling fake explicit assistant
 * text. Its default is to concatenate the complete input history, which makes
 * a follow-up response echo ToolMessage content. createAgent binds tools by
 * constructing a fresh fake, so carry the decoration across that boundary.
 */
function withExplicitContent(
  model: FakeToolCallingModel,
  content: string,
): FakeToolCallingModel {
  const originalGenerate = model._generate.bind(model);
  model._generate = async (
    ...args: Parameters<FakeToolCallingModel['_generate']>
  ) => {
    const result = await originalGenerate(...args);
    const generation = result.generations[0];
    if (generation !== undefined) {
      generation.text = content;
      generation.message.content = content;
    }
    return result;
  };

  const originalBindTools = model.bindTools.bind(model);
  model.bindTools = (
    ...args: Parameters<FakeToolCallingModel['bindTools']>
  ) => {
    const bound = originalBindTools(...args);
    return bound instanceof FakeToolCallingModel
      ? withExplicitContent(bound, content)
      : bound;
  };
  return model;
}

let tmpDir: string;
const openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-integration-'));
  harness.groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(harness.groupsDir, { recursive: true });
  harness.checkpointerDbPath = path.join(tmpDir, 'checkpoints.db');
  harness.makeModel = answerOnlyModel;
  harness.tools = [];
  harness.captured = [];
  _resetCheckpointerForTests();
  _initTestDatabase();
});

afterEach(async () => {
  while (openHandles.length > 0) {
    await openHandles.pop()?.close();
  }
  _resetCheckpointerForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startServer() {
  const handle = await startNativeChatServer({
    registry: {
      get: (id) =>
        id === 'deus-native' ? createDeusNativeRuntime(stubDeps) : undefined,
    },
    sessions: createDbSessionStore(),
    discoveryPath: path.join(tmpDir, 'native-chat.json'),
  });
  openHandles.push(handle);
  return handle;
}

function transportFor(handle: Awaited<ReturnType<typeof startServer>>) {
  const record = parseDiscoveryRecord(
    fs.readFileSync(handle.discoveryPath, 'utf8'),
  );
  expect(record).toBeDefined();
  return createHttpChatTransport(record!);
}

async function checkpointedTexts(threadId: string): Promise<string[]> {
  const tuple = await getCheckpointer().getTuple({
    configurable: { thread_id: threadId },
  });
  const messages =
    ((tuple?.checkpoint.channel_values as { messages?: unknown[] })
      ?.messages as unknown[]) ?? [];
  return messages
    .map((m) => (m as { content?: unknown }).content)
    .filter((c): c is string => typeof c === 'string');
}

describe('deus chat end-to-end (hermetic)', () => {
  it('two client turns share one runtime UUID and one real checkpointer thread; a restarted daemon resumes it (AC2 + AC4)', async () => {
    const serverA = await startServer();
    const clientA = transportFor(serverA);

    // Turn 1 (client A).
    await clientA.turn('remember the word: pomegranate', tmpDir, () => {});
    const stored1 = getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native');
    expect(stored1?.session_id).toMatch(UUID_PATTERN);

    // Turn 2 (client A) — same persisted UUID, and the checkpointer thread
    // holds BOTH user messages (real continuity, not just "no error").
    await clientA.turn('what did I ask you to remember?', tmpDir, () => {});
    const stored2 = getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native');
    expect(stored2?.session_id).toBe(stored1?.session_id);

    const texts = await checkpointedTexts(stored2!.session_id);
    expect(
      texts.some((t) => t.includes('remember the word: pomegranate')),
    ).toBe(true);
    expect(
      texts.some((t) => t.includes('what did I ask you to remember?')),
    ).toBe(true);

    // Status exposes backend + full session id (AC5).
    const statusA = await clientA.status();
    expect(statusA.backend).toBe('deus-native');
    expect(statusA.sessionId).toBe(stored1?.session_id);

    // Client A exits cleanly; the stored row must survive.
    await clientA.close();
    await serverA.close();
    openHandles.pop();
    expect(getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      stored1?.session_id,
    );

    // "Client B": a fresh daemon server + fresh controller over the same
    // stores — /status reports resumed with the same id, and turn 3 reaches
    // the SAME checkpointer thread.
    const serverB = await startServer();
    const clientB = transportFor(serverB);
    const statusB = await clientB.status();
    expect(statusB.state).toBe('resumed');
    expect(statusB.sessionId).toBe(stored1?.session_id);

    await clientB.turn('third turn after resume', tmpDir, () => {});
    expect(getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id).toBe(
      stored1?.session_id,
    );
    const textsAfterResume = await checkpointedTexts(stored1!.session_id);
    expect(
      textsAfterResume.some((t) =>
        t.includes('remember the word: pomegranate'),
      ),
    ).toBe(true);
    expect(
      textsAfterResume.some((t) => t.includes('third turn after resume')),
    ).toBe(true);
  });

  it('renders readable tool feedback through the full client loop with zero protocol framing (AC1 + AC3)', async () => {
    harness.tools = [ECHO_TOOL];
    harness.makeModel = toolCallThenAnswerModel;

    const server = await startServer();
    const transport = transportFor(server);

    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    errorOutput.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const done = runChatCli({
      input,
      output,
      errorOutput,
      transport,
      cwd: tmpDir,
    });
    input.write('use your echo tool\n');
    input.write('/exit\n');
    input.end();
    const code = await done;
    expect(code).toBe(0);

    // Human-readable tool feedback from the real runtime tool-call event.
    expect(stdout).toContain('Using echo_tool');

    // AC3: raw RuntimeEvent / NDJSON strings never reach the terminal.
    for (const streamText of [stdout, stderr]) {
      expect(streamText).not.toContain('{"type":');
      expect(streamText).not.toContain('{"kind":');
      expect(streamText).not.toContain('output_text');
      expect(streamText).not.toContain('turn_complete');
      expect(streamText).not.toContain('tool_call');
      expect(streamText).not.toContain('sessionRef');
      expect(streamText).not.toContain('"done"');
    }
    // The session persisted through the real turn.
    expect(
      getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native')?.session_id,
    ).toMatch(UUID_PATTERN);
  });

  it('toggles plan mode through the real CLI, denies mutation with model-visible feedback, then restores default in the same thread', async () => {
    const mutationHandler = vi.fn(
      async (args: { path: string; content: string }) =>
        `wrote:${args.path}:${args.content.length}`,
    );
    harness.tools = [
      tool(mutationHandler, {
        name: 'write_file',
        description: 'Hermetic mutation double for plan-mode enforcement.',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      }),
    ];
    let modelNumber = 0;
    harness.makeModel = () => {
      modelNumber += 1;
      return withExplicitContent(
        new FakeToolCallingModel({
          toolCalls: [
            [
              {
                name: 'write_file',
                args: {
                  path: `/sentinel-${modelNumber}`,
                  content: `secret-${modelNumber}`,
                },
                id: `write_call_${modelNumber}`,
              },
            ],
            [],
          ],
        }),
        `Scripted mutation response ${modelNumber}.`,
      );
    };

    const server = await startServer();
    const transport = transportFor(server);
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    errorOutput.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const done = runChatCli({
      input,
      output,
      errorOutput,
      transport,
      cwd: tmpDir,
    });
    input.write('/plan on\n');
    input.write('attempt the first mutation\n');
    input.write('/plan off\n');
    input.write('attempt the second mutation\n');
    input.write('/status\n');
    input.write('/exit\n');
    input.end();
    expect(await done).toBe(0);

    // Only the post-disable mutation reached the underlying handler.
    expect(mutationHandler).toHaveBeenCalledTimes(1);
    expect(mutationHandler.mock.calls[0]?.[0]).toEqual({
      path: '/sentinel-2',
      content: 'secret-2',
    });

    // The real agent performed a follow-up model call with the synthetic
    // denial ToolMessage in context, so the model could continue normally.
    const denial = harness.captured
      .flatMap((capture) => capture.messages)
      .find(
        (message): message is ToolMessage =>
          ToolMessage.isInstance(message as never) &&
          (message as ToolMessage).tool_call_id === 'write_call_1',
      );
    expect(denial).toBeDefined();
    expect(denial?.status).toBe('error');
    const denialContent = String(denial?.content);
    expect(denialContent).toContain('permission_denied');
    expect(denialContent).toContain('write_file');
    expect(denialContent).toContain('read-only');
    expect(denialContent).toContain('call was not executed');
    expect(denialContent).not.toContain('/sentinel-1');
    expect(denialContent).not.toContain('secret-1');
    expect(
      harness.captured.some((capture) => capture.messages.includes(denial!)),
    ).toBe(true);

    // Both prompts persisted in one backend-scoped session/checkpointer.
    const stored = getSession(CLI_CHAT_GROUP_FOLDER, 'deus-native');
    expect(stored?.session_id).toMatch(UUID_PATTERN);
    const texts = await checkpointedTexts(stored!.session_id);
    expect(texts).toContain('attempt the first mutation');
    expect(texts).toContain('attempt the second mutation');

    expect(stdout).toContain('Mode:    plan (read-only)');
    expect(stdout).toContain('Mode:    normal (default)');
    for (const streamText of [stdout, stderr]) {
      expect(streamText).not.toContain('{"kind":');
      expect(streamText).not.toContain('permission_denied');
      expect(streamText).not.toContain('sessionRef');
      expect(streamText).not.toContain('"done"');
    }
  });
});
