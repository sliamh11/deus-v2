import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatOllama } from '@langchain/ollama';
import { createAgent, type CreateAgentParams } from 'langchain';

// Local model on purpose: A6 tests checkpointer persistence mechanics, not
// billing/auth (A4's job) or MCP consumption (A5's job) — routing through the
// Anthropic proxy would re-expose this spike to the real 429 rate-limit
// fragility both A4 and A5 hit, for zero additional signal about SQLite
// persistence. A3's spike (lia396) defines the same constants on its own
// unmerged branch; duplicated here rather than imported across branches.
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_SUB_MODEL_ID = 'gemma4:e2b';

// The start turn plants a distinctive marker the resume assertions can look
// for verbatim in the reloaded transcript — the proof is structural (the
// persisted messages round-trip through SQLite), never dependent on the
// local model actually recalling the fact.
export const START_PROMPT =
  'Remember this fact: the persistence marker is "teal-482". Reply with one word.';
export const RESUME_PROMPT =
  'What is the persistence marker I told you earlier? Reply with only the marker.';

export type SpikeAgent = ReturnType<typeof createAgent>;

// The exact model union createAgent accepts (string | AgentLanguageModelLike);
// AgentLanguageModelLike itself is not re-exported from langchain's top-level
// index, so it is derived from the exported CreateAgentParams instead.
export type SpikeModel = CreateAgentParams['model'];

export interface CheckpointerAgent {
  agent: SpikeAgent;
  checkpointer: SqliteSaver;
}

export interface UserTurnMessage {
  role: 'user';
  content: string;
}

export type TurnResult =
  | { succeeded: true; messages: BaseMessage[] }
  | { succeeded: false; error: string };

export interface CheckpointLocation {
  found: boolean;
  checkpointId?: string;
  checkpointMessageCount?: number;
}

export interface SerializedMessage {
  type: string;
  text: string;
}

export interface CliArgs {
  mode: 'start' | 'resume';
  db: string;
  thread: string;
}

export interface MainReport {
  mode: 'start' | 'resume';
  threadId: string;
  dbPath: string;
  checkpointBeforeTurn: CheckpointLocation;
  turn: { succeeded: boolean; error?: string };
  messageCount?: number;
  messages?: SerializedMessage[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  // JSON.stringify(undefined) returns runtime `undefined`, not a string —
  // TS's own lib.es5.d.ts types JSON.stringify as always returning `string`
  // (a known gap, unrelated to strict mode), so this can't be caught
  // statically; guard it explicitly instead.
  return JSON.stringify(content) ?? String(content);
}

export function buildOllamaModel(): ChatOllama {
  return new ChatOllama({
    model: OLLAMA_SUB_MODEL_ID,
    baseUrl: OLLAMA_BASE_URL,
    temperature: 0,
  });
}

/**
 * A brand-new SqliteSaver + brand-new agent per call — this function IS the
 * "fresh runtime instance" seam: calling it twice against the same db path
 * shares zero JS state, so anything the second agent sees must have come
 * back through SQLite. SqliteSaver's own setup() is protected, lazy, and
 * idempotent (invoked internally by getTuple/list/put/putWrites), so it is
 * deliberately never called here.
 *
 * The model parameter is injectable so hermetic tests can exercise the REAL
 * SqliteSaver + createAgent persistence path with a scripted fake model —
 * CI's root vitest job runs this spike's tests and has no Ollama daemon.
 */
export function createCheckpointerAgent(
  dbPath: string,
  model: SpikeModel = buildOllamaModel(),
): CheckpointerAgent {
  const checkpointer = SqliteSaver.fromConnString(dbPath);
  const agent = createAgent({ model, checkpointer });
  return { agent, checkpointer };
}

// SqliteSaver exposes no close() of its own; its better-sqlite3 handle is
// the public `db` field and the caller owns its lifecycle.
export function closeCheckpointer(checkpointer: SqliteSaver): void {
  checkpointer.db.close();
}

/**
 * Locates the saved checkpoint for a session identifier (thread_id) directly
 * through the checkpointer — the AC2 proof, independent of any agent invoke.
 */
export async function locateCheckpoint(
  checkpointer: SqliteSaver,
  threadId: string,
): Promise<CheckpointLocation> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });
  if (tuple === undefined) return { found: false };
  // channel_values is a dynamic per-graph-channel map (LangGraph's internal
  // checkpoint shape has no public type for it) -- casting is the only way
  // to peek at the well-known 'messages' channel from outside the graph.
  const channelMessages = (
    tuple.checkpoint.channel_values as { messages?: unknown } | undefined
  )?.messages;
  return {
    found: true,
    checkpointId: tuple.checkpoint.id,
    checkpointMessageCount: Array.isArray(channelMessages)
      ? channelMessages.length
      : undefined,
  };
}

export async function runTurn(
  agent: SpikeAgent,
  threadId: string,
  messages: UserTurnMessage[],
): Promise<TurnResult> {
  try {
    const result = await agent.invoke(
      { messages },
      { configurable: { thread_id: threadId } },
    );
    // createAgent's return type is a generic StateGraph whose shape TS can't
    // narrow through `SpikeAgent = ReturnType<typeof createAgent>` — the
    // runtime shape (a `messages: BaseMessage[]` field) is exactly what
    // A1/A3/A4/A5 already invoke().messages against, just not expressible
    // here without threading createAgent's full generic parameters through.
    // (If a full StateSnapshot were needed instead, agent.graph.getState(config)
    // is the real typed method — agent.getState()/getStateHistory() on the
    // ReactAgent itself are typed `never` and marked @internal.)
    return {
      succeeded: true,
      messages: (result as { messages: BaseMessage[] }).messages,
    };
  } catch (error) {
    return { succeeded: false, error: errorMessage(error) };
  }
}

export function serializeMessages(
  messages: BaseMessage[],
): SerializedMessage[] {
  return messages.map((message) => ({
    type: message.getType(),
    text: stringifyContent(message.content),
  }));
}

export function parseCliArgs(argv: string[]): CliArgs {
  const usage = 'usage: --mode=start|resume --db=<path> --thread=<id>';
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(mode|db|thread)=(.+)$/.exec(arg);
    if (match === null) {
      throw new Error(`unrecognized argument: ${arg} (${usage})`);
    }
    values.set(match[1] as string, match[2] as string);
  }
  const mode = values.get('mode');
  const db = values.get('db');
  const thread = values.get('thread');
  if (
    (mode !== 'start' && mode !== 'resume') ||
    db === undefined ||
    thread === undefined
  ) {
    throw new Error(usage);
  }
  return { mode, db, thread };
}

export interface MainDependencies {
  createCheckpointerAgent: typeof createCheckpointerAgent;
  locateCheckpoint: typeof locateCheckpoint;
  runTurn: typeof runTurn;
  closeCheckpointer: typeof closeCheckpointer;
}

/**
 * CLI proof harness: `--mode=start` runs the first turn against a (typically
 * fresh) db; a separate later process runs `--mode=resume` against the same
 * db + thread and its report shows the reloaded prior-turn messages. Prints
 * exactly one JSON line to stdout (the A4/A5 parse-child-stdout convention)
 * so a parent test can spawn two real child processes and assert on both
 * reports.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDependencies = {
    createCheckpointerAgent,
    locateCheckpoint,
    runTurn,
    closeCheckpointer,
  },
): Promise<void> {
  const args = parseCliArgs(argv);
  const { agent, checkpointer } = deps.createCheckpointerAgent(args.db);

  try {
    // Located BEFORE the turn runs: in resume mode this proves the session
    // identifier alone finds the previous process's saved checkpoint, before
    // any new model call could have written anything.
    const checkpointBeforeTurn = await deps.locateCheckpoint(
      checkpointer,
      args.thread,
    );
    const prompt = args.mode === 'start' ? START_PROMPT : RESUME_PROMPT;
    const turn = await deps.runTurn(agent, args.thread, [
      { role: 'user', content: prompt },
    ]);

    const report: MainReport = turn.succeeded
      ? {
          mode: args.mode,
          threadId: args.thread,
          dbPath: args.db,
          checkpointBeforeTurn,
          turn: { succeeded: true },
          messageCount: turn.messages.length,
          messages: serializeMessages(turn.messages),
        }
      : {
          mode: args.mode,
          threadId: args.thread,
          dbPath: args.db,
          checkpointBeforeTurn,
          turn: { succeeded: false, error: turn.error },
        };
    console.log(JSON.stringify(report));
  } finally {
    deps.closeCheckpointer(checkpointer);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('A6 spike failed:', errorMessage(error));
    process.exitCode = 1;
  });
}
