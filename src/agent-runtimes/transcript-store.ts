import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { STORE_DIR } from '../config.js';
import { UserError } from '../errors/index.js';
import { IS_WINDOWS } from '../platform.js';

export interface TranscriptUsageEvent {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TranscriptToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TranscriptTurnInput {
  sessionId: string;
  groupFolder: string;
  cwd?: string;
  prompt: string;
  assistantText: string;
  userMessageId: string;
  assistantMessageId?: string;
  primaryModel: string;
  toolCalls: readonly TranscriptToolCall[];
  usageEvents: readonly TranscriptUsageEvent[];
  startedAt: Date;
  completedAt: Date;
}

export type TranscriptWriteResult =
  { ok: true; path: string } | { ok: false; path?: string; error: unknown };

interface AppendOptions {
  rootDir?: string;
  warn?: (message: string, error: unknown) => void;
}

interface TranscriptMessageUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

const pendingAppends = new Map<string, Promise<void>>();

export function resolveDeusNativeTranscriptRoot(
  rootDir: string = STORE_DIR,
): string {
  return path.join(rootDir, 'transcripts', 'deus-native');
}

export function resolveDeusNativeTranscriptPath(
  sessionId: string,
  options: { rootDir?: string } = {},
): string {
  if (sessionId.length === 0) {
    throw new UserError('deus-native transcript session id must not be empty');
  }
  const hash = crypto
    .createHash('sha256')
    .update(sessionId, 'utf8')
    .digest('hex');
  return path.join(
    resolveDeusNativeTranscriptRoot(options.rootDir),
    `${hash}.jsonl`,
  );
}

function jsonSafeObject(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: unknown = JSON.parse(JSON.stringify(input));
  return normalized !== null &&
    typeof normalized === 'object' &&
    !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : {};
}

function definedUsage(event: TranscriptUsageEvent): TranscriptUsageEvent {
  return {
    provider: event.provider,
    model: event.model,
    ...(event.inputTokens !== undefined
      ? { inputTokens: event.inputTokens }
      : {}),
    ...(event.outputTokens !== undefined
      ? { outputTokens: event.outputTokens }
      : {}),
    ...(event.totalTokens !== undefined
      ? { totalTokens: event.totalTokens }
      : {}),
  };
}

function compatibilityUsage(
  events: readonly TranscriptUsageEvent[],
): TranscriptMessageUsage | undefined {
  if (events.length !== 1) return undefined;
  const [event] = events;
  if (
    event.inputTokens === undefined ||
    event.outputTokens === undefined ||
    event.totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    total_tokens: event.totalTokens,
  };
}

function serializeTurn(input: TranscriptTurnInput): string {
  const turnId = crypto.randomUUID();
  const assistantMessageId = input.assistantMessageId ?? crypto.randomUUID();
  const toolCalls = input.toolCalls.map((call) => ({
    ...(call.id !== undefined ? { id: call.id } : {}),
    name: call.name,
    input: jsonSafeObject(call.input),
  }));
  const usage = input.usageEvents.map(definedUsage);
  const messageUsage = compatibilityUsage(input.usageEvents);

  const user = {
    schemaVersion: 1,
    source: 'deus-native',
    type: 'user',
    sessionId: input.sessionId,
    uuid: input.userMessageId,
    turnId,
    timestamp: input.startedAt.toISOString(),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    groupFolder: input.groupFolder,
    role: 'user',
    message: {
      id: input.userMessageId,
      role: 'user',
      content: input.prompt,
    },
    deusNative: {
      backend: 'deus-native',
      schema: 'deus-native-transcript-v1',
    },
  };
  const assistant = {
    schemaVersion: 1,
    source: 'deus-native',
    type: 'assistant',
    sessionId: input.sessionId,
    uuid: assistantMessageId,
    parentUuid: input.userMessageId,
    turnId,
    timestamp: input.completedAt.toISOString(),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    groupFolder: input.groupFolder,
    role: 'assistant',
    message: {
      id: assistantMessageId,
      role: 'assistant',
      model: input.primaryModel,
      content: [
        { type: 'text', text: input.assistantText },
        ...toolCalls.map((call) => ({
          type: 'tool_use',
          ...(call.id !== undefined ? { id: call.id } : {}),
          name: call.name,
          input: call.input,
        })),
      ],
      stop_reason: 'end_turn',
      ...(messageUsage !== undefined ? { usage: messageUsage } : {}),
    },
    deusNative: {
      backend: 'deus-native',
      schema: 'deus-native-transcript-v1',
      usage,
      toolCalls: toolCalls.map((call) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        name: call.name,
      })),
    },
  };

  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}

async function appendPayload(transcriptPath: string, payload: string) {
  const transcriptRoot = path.dirname(transcriptPath);
  await fs.mkdir(transcriptRoot, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) await fs.chmod(transcriptRoot, 0o700);

  const handle = await fs.open(transcriptPath, 'a', 0o600);
  try {
    if (!IS_WINDOWS) await handle.chmod(0o600);
    await handle.appendFile(payload, 'utf8');
  } finally {
    await handle.close();
  }
}

function enqueue(
  transcriptPath: string,
  operation: () => Promise<void>,
): Promise<void> {
  const predecessor = pendingAppends.get(transcriptPath) ?? Promise.resolve();
  const current = predecessor.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  pendingAppends.set(transcriptPath, settled);
  void settled.finally(() => {
    if (pendingAppends.get(transcriptPath) === settled) {
      pendingAppends.delete(transcriptPath);
    }
  });
  return current;
}

export async function appendDeusNativeTranscriptTurn(
  input: TranscriptTurnInput,
  options: AppendOptions = {},
): Promise<TranscriptWriteResult> {
  let transcriptPath: string | undefined;
  try {
    transcriptPath = resolveDeusNativeTranscriptPath(input.sessionId, options);
    const payload = serializeTurn(input);
    await enqueue(transcriptPath, () =>
      appendPayload(transcriptPath!, payload),
    );
    return { ok: true, path: transcriptPath };
  } catch (error) {
    const warn =
      options.warn ??
      ((message: string, failure: unknown) => console.warn(message, failure));
    warn(
      `deus-native transcript append failed${transcriptPath ? ` at ${transcriptPath}` : ''}`,
      error,
    );
    return {
      ok: false,
      ...(transcriptPath !== undefined ? { path: transcriptPath } : {}),
      error,
    };
  }
}
