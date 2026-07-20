/**
 * LIA-454 EP-002 step 10: tests for `runParentTurnViaCliSubprocess` — the
 * transport-neutral parent-turn orchestrator built entirely with fakes (no
 * real CLI subprocess spawn; that's step 12's real credentialed smoke
 * test). Central focus, per the plan's own step-10 acceptance bar: the
 * checkpoint-before-success invariant — a turn can never be reported
 * successful without its checkpoint durably persisted first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';

import { COMPACTION_TOKEN_THRESHOLD_ENV } from '../context-compaction.js';
import { persistCliCheckpoint } from './checkpoint-translation.js';
import {
  NESTED_DISPATCH_USAGE_FILENAME,
  appendNestedDispatchUsage,
} from './nested-dispatch-usage-channel.js';
import { runParentTurnViaCliSubprocess } from './parent-turn-runner.js';
import type { ClaudeCliSessionPool } from './claude-cli-session-pool.js';
import type {
  ProcessSlotLease,
  ThreadTurnLease,
} from './process-lifecycle-registry.js';
import type { StreamJsonEvent } from './stream-json-protocol.js';

const MCP_SERVER_NAME = 'deus_lia454_parent';

function assistantTextEvent(text: string, id = 'msg_1'): StreamJsonEvent {
  return {
    type: 'assistant',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      id,
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function resultEvent(text?: string): StreamJsonEvent {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's1',
    ...(text !== undefined ? { result: text } : {}),
  };
}

function fakePool(
  overrides: {
    createConversation?: (id: string, options: unknown) => Promise<unknown>;
    sendTurn?: (id: string, prompt: string) => Promise<unknown>;
  } = {},
): {
  pool: ClaudeCliSessionPool;
  terminateCalls: string[];
  createConversationCalls: Array<{ id: string; options: unknown }>;
} {
  const terminateCalls: string[] = [];
  const createConversationCalls: Array<{ id: string; options: unknown }> = [];
  const pool = {
    createConversation: vi.fn(async (id: string, options: unknown) => {
      createConversationCalls.push({ id, options });
      if (overrides.createConversation) {
        return overrides.createConversation(id, options);
      }
      return { conversationId: id, pid: 1 };
    }),
    sendTurn: vi.fn(async (id: string, prompt: string) => {
      if (overrides.sendTurn) return overrides.sendTurn(id, prompt);
      return {
        result: { is_error: false, result: 'hi there', session_id: 's1' },
        events: [],
        turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
        timing: { totalTurnMs: 10 },
        pid: 1,
      };
    }),
    terminate: vi.fn(async (id: string) => {
      terminateCalls.push(id);
    }),
  } as unknown as ClaudeCliSessionPool;
  return { pool, terminateCalls, createConversationCalls };
}

function fakeLease(): { lease: ThreadTurnLease; releaseCount: () => number } {
  let count = 0;
  const lease: ThreadTurnLease = {
    threadHash: 'hash',
    path: '/fake/lease/path',
    release: () => {
      count += 1;
    },
  };
  return { lease, releaseCount: () => count };
}

function fakeSlot(): { slot: ProcessSlotLease; releaseCount: () => number } {
  let count = 0;
  const slot: ProcessSlotLease = {
    slotIndex: 0,
    path: '/fake/slot/path',
    release: () => {
      count += 1;
    },
  };
  return { slot, releaseCount: () => count };
}

// Tracks EVERY tempSaver() created this test (a single test can create more
// than one, e.g. the cleanup-on-success-and-error test below) so afterEach
// cleans all of them, not just the last. Each saver's underlying
// better-sqlite3 handle is closed BEFORE its dir is removed — required
// cross-platform (matches `checkpointer.ts`'s own `_resetCheckpointerForTests`
// precedent): on Windows a still-open sqlite file blocks `fs.rmSync`/`unlink`
// with `EBUSY`, a real failure this suite hit once Windows CI actually ran
// it (caught at LIA-454 EP-002 step 13's PR CI, not locally on POSIX).
const createdSavers: Array<{ saver: SqliteSaver; dir: string }> = [];
afterEach(() => {
  for (const { saver, dir } of createdSavers.splice(0)) {
    saver.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempSaver(): { saver: SqliteSaver; dir: string } {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia454-parent-turn-runner-'),
  );
  const dbPath = path.join(dir, 'checkpoints.db');
  const created = { saver: SqliteSaver.fromConnString(dbPath), dir };
  createdSavers.push(created);
  return created;
}

function baseOptions(
  overrides: Partial<Parameters<typeof runParentTurnViaCliSubprocess>[0]> = {},
) {
  return {
    threadId: 'thread-1',
    prompt: 'hello',
    currentTurnMessageId: 'msg_1',
    mcpServerContext: { permissionProfile: 'default', wardenCwd: '/repo' },
    ...overrides,
  };
}

function baseDeps(
  pool: ClaudeCliSessionPool,
  saver: BaseCheckpointSaver,
  lease: ThreadTurnLease,
  slot: ProcessSlotLease,
): Parameters<typeof runParentTurnViaCliSubprocess>[1] {
  return {
    pool,
    mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
    mcpServerName: MCP_SERVER_NAME,
    repoRoot: '/repo',
    scratchDirFor: (id: string) => `/tmp/scratch/${id}`,
    saver,
    acquireThreadTurnLease: async () => lease,
    acquireProcessSlot: async () => slot,
  };
}

describe('runParentTurnViaCliSubprocess: success path', () => {
  it('persists a real checkpoint BEFORE returning success, and releases the lease + slot + terminates the conversation', async () => {
    const { pool, terminateCalls } = fakePool();
    const { saver } = tempSaver();
    const { lease, releaseCount: leaseReleaseCount } = fakeLease();
    const { slot, releaseCount } = fakeSlot();

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions(),
      baseDeps(pool, saver, lease, slot),
    );

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.finalAssistantText).toBe('hi there');
      expect(outcome.model).toBe('claude-sonnet-5');
      expect(outcome.provider).toBe('anthropic');
      expect(outcome.newMessages.length).toBeGreaterThan(0);
    }

    // The checkpoint is REALLY there — not just claimed.
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-1', checkpoint_ns: '' },
    });
    expect(tuple).toBeDefined();
    const messages = tuple?.checkpoint.channel_values['messages'] as unknown[];
    expect(messages.length).toBeGreaterThan(0);

    expect(terminateCalls).toHaveLength(1);
    expect(leaseReleaseCount()).toBe(1);
    expect(releaseCount()).toBe(1);
  });
});

describe('runParentTurnViaCliSubprocess: lease/slot acquisition', () => {
  it('returns an error and never touches the pool when the thread-turn lease is unavailable', async () => {
    const { pool, createConversationCalls } = fakePool();
    const { saver } = tempSaver();
    const { slot } = fakeSlot();

    const outcome = await runParentTurnViaCliSubprocess(baseOptions(), {
      pool,
      mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
      mcpServerName: MCP_SERVER_NAME,
      repoRoot: '/repo',
      scratchDirFor: (id) => `/tmp/${id}`,
      saver,
      acquireThreadTurnLease: async () => null,
      acquireProcessSlot: async () => slot,
    });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toContain('thread-turn lease');
    }
    expect(createConversationCalls).toHaveLength(0);
  });

  it('returns an error, still releases the lease, and never touches the pool when no process slot is available', async () => {
    const { pool, createConversationCalls } = fakePool();
    const { saver } = tempSaver();
    const { lease, releaseCount: leaseReleaseCount } = fakeLease();

    const outcome = await runParentTurnViaCliSubprocess(baseOptions(), {
      pool,
      mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
      mcpServerName: MCP_SERVER_NAME,
      repoRoot: '/repo',
      scratchDirFor: (id) => `/tmp/${id}`,
      saver,
      acquireThreadTurnLease: async () => lease,
      acquireProcessSlot: async () => null,
    });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toContain('process slot');
    }
    expect(createConversationCalls).toHaveLength(0);
    expect(leaseReleaseCount()).toBe(1);
  });
});

describe('runParentTurnViaCliSubprocess: checkpoint-before-success invariant', () => {
  it('returns an error (never success) when the checkpoint write itself fails, even though the CLI turn succeeded — and still releases everything', async () => {
    const { pool, terminateCalls } = fakePool();
    const { lease, releaseCount: leaseReleaseCount } = fakeLease();
    const { slot, releaseCount } = fakeSlot();

    // A fake saver whose getTuple() answers DIFFERENTLY on its second call
    // (persistCliCheckpoint's own stale-parent re-read) than its first
    // (this runner's initial read) — simulating an uncoordinated concurrent
    // writer slipping in between, which persistCliCheckpoint's own
    // invariant assertion must refuse to silently overwrite.
    let getTupleCalls = 0;
    const flakySaver = {
      getTuple: vi.fn(async () => {
        getTupleCalls += 1;
        if (getTupleCalls === 1) return undefined;
        return {
          checkpoint: { id: 'someone-elses-checkpoint' },
        } as unknown;
      }),
      put: vi.fn(),
      getNextVersion: vi.fn(() => 1),
    } as unknown as BaseCheckpointSaver;

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions(),
      baseDeps(pool, flakySaver, lease, slot),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toContain('stale parent checkpoint');
    }
    expect(flakySaver.put).not.toHaveBeenCalled();
    expect(terminateCalls).toHaveLength(1); // conversation was still cleaned up
    expect(leaseReleaseCount()).toBe(1);
    expect(releaseCount()).toBe(1);
  });
});

describe('runParentTurnViaCliSubprocess: CLI-side failures', () => {
  it('returns an error, never persists a checkpoint, when the CLI turn itself reports is_error', async () => {
    const { pool, terminateCalls } = fakePool({
      sendTurn: async () => ({
        result: { is_error: true, result: 'boom', session_id: 's1' },
        events: [],
        turnEvents: [],
        timing: { totalTurnMs: 1 },
        pid: 1,
      }),
    });
    const { saver } = tempSaver();
    const { lease, releaseCount: leaseReleaseCount } = fakeLease();
    const { slot, releaseCount } = fakeSlot();

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions(),
      baseDeps(pool, saver, lease, slot),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toBe('boom');
    }
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-1', checkpoint_ns: '' },
    });
    expect(tuple).toBeUndefined();
    expect(terminateCalls).toHaveLength(1);
    expect(leaseReleaseCount()).toBe(1);
    expect(releaseCount()).toBe(1);
  });

  it('returns an error and does NOT call terminate when createConversation itself throws (conversation never existed)', async () => {
    const { pool, terminateCalls } = fakePool({
      createConversation: async () => {
        throw new Error('ENOENT: no claude on PATH');
      },
    });
    const { saver } = tempSaver();
    const { lease, releaseCount: leaseReleaseCount } = fakeLease();
    const { slot, releaseCount } = fakeSlot();

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions(),
      baseDeps(pool, saver, lease, slot),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error).toContain('ENOENT');
    }
    expect(terminateCalls).toHaveLength(0);
    expect(leaseReleaseCount()).toBe(1);
    expect(releaseCount()).toBe(1);
  });
});

describe('runParentTurnViaCliSubprocess: conversation wiring', () => {
  it('marshals mcpServerContext into DEUS_PARENT_TURN_CONTEXT and derives allowedTool from the fixed 3-tool parent catalog', async () => {
    const { pool, createConversationCalls } = fakePool();
    const { saver } = tempSaver();
    const { lease } = fakeLease();
    const { slot } = fakeSlot();

    await runParentTurnViaCliSubprocess(
      baseOptions({
        mcpServerContext: { permissionProfile: 'read-only', wardenCwd: '/x' },
      }),
      baseDeps(pool, saver, lease, slot),
    );

    expect(createConversationCalls[0].options).toMatchObject({
      mcpServerEnv: {
        DEUS_PARENT_TURN_CONTEXT: JSON.stringify({
          permissionProfile: 'read-only',
          wardenCwd: '/x',
        }),
      },
      allowedTool: [
        `mcp__${MCP_SERVER_NAME}__web_search`,
        `mcp__${MCP_SERVER_NAME}__web_fetch`,
        `mcp__${MCP_SERVER_NAME}__dispatch_nested_agent`,
      ].join(','),
    });
  });
});

describe('runParentTurnViaCliSubprocess: history injection (LIA-454 EP-002 step 11 fix)', () => {
  let historyScratchRoot: string;
  afterEach(() => {
    if (historyScratchRoot) {
      fs.rmSync(historyScratchRoot, { recursive: true, force: true });
    }
  });

  function historyDeps(
    pool: ClaudeCliSessionPool,
    saver: BaseCheckpointSaver,
    overrides: Partial<
      Parameters<typeof runParentTurnViaCliSubprocess>[1]
    > = {},
  ): Parameters<typeof runParentTurnViaCliSubprocess>[1] {
    historyScratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lia454-parent-history-'),
    );
    const { lease } = fakeLease();
    const { slot } = fakeSlot();
    return {
      pool,
      mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
      mcpServerName: MCP_SERVER_NAME,
      repoRoot: '/repo',
      scratchDirFor: (id: string) => path.join(historyScratchRoot, id),
      saver,
      acquireThreadTurnLease: async () => lease,
      acquireProcessSlot: async () => slot,
      ...overrides,
    };
  }

  it('invokes loadSessionOpenText exactly once for a new thread and never for a resumed thread', async () => {
    const { pool } = fakePool();
    const { saver } = tempSaver();
    const loadSessionOpenText = vi.fn(async () => 'welcome context');
    const deps = historyDeps(pool, saver, { loadSessionOpenText });

    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-session-open' }),
      deps,
    );
    expect(loadSessionOpenText).toHaveBeenCalledTimes(1);

    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-session-open', prompt: 'follow-up' }),
      deps,
    );
    expect(loadSessionOpenText).toHaveBeenCalledTimes(1); // still 1 -- not called again
  });

  it('writes prior messages into a history file and passes its path as appendSystemPromptFile on the NEXT turn', async () => {
    // The turn's own finally-block cleanup deletes the history file before
    // this call returns, so its content can't be read post-hoc -- spy on
    // the real write call instead (still calling through) to capture what
    // was actually written.
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const { pool, createConversationCalls } = fakePool();
    const { saver } = tempSaver();
    const deps = historyDeps(pool, saver);

    // First turn: brand-new thread, no prior history yet -> no history file.
    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-hist' }),
      deps,
    );
    expect(createConversationCalls[0].options).not.toHaveProperty(
      'appendSystemPromptFile',
    );

    // Second turn, same thread: the first turn's persisted messages are
    // now prior history and must reach the CLI.
    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-hist', prompt: 'follow-up' }),
      deps,
    );
    const secondOptions = createConversationCalls[1].options as {
      appendSystemPromptFile?: string;
    };
    expect(secondOptions.appendSystemPromptFile).toBeDefined();

    const historyWriteCall = writeSpy.mock.calls.find(
      ([writtenPath]) => writtenPath === secondOptions.appendSystemPromptFile,
    );
    expect(historyWriteCall).toBeDefined();
    const historyContent = historyWriteCall?.[1];
    expect(historyContent).toContain('hi there'); // first turn's assistant reply
    expect(historyContent).toContain('<prior-conversation-history>');
    writeSpy.mockRestore();
  });

  it('writes the history file with mode 0600', async () => {
    // The turn's own finally-block cleanup deletes the file before this
    // call returns, so mode can't be checked post-hoc -- spy on the real
    // write call instead (still calling through) to capture the exact
    // options it was written with.
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const { pool } = fakePool();
    const { saver } = tempSaver();
    const loadSessionOpenText = vi.fn(async () => 'welcome context');
    const deps = historyDeps(pool, saver, { loadSessionOpenText });

    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-mode' }),
      deps,
    );

    const historyWriteCall = writeSpy.mock.calls.find(([, content]) =>
      typeof content === 'string' ? content.includes('welcome context') : false,
    );
    expect(historyWriteCall).toBeDefined();
    expect(historyWriteCall?.[2]).toMatchObject({ mode: 0o600 });
    writeSpy.mockRestore();
  });

  it('cleans up the history file after the turn completes, whether the turn succeeds or the CLI reports is_error', async () => {
    const loadSessionOpenText = vi.fn(async () => 'welcome context');

    const successPool = fakePool();
    const successDeps = historyDeps(successPool.pool, tempSaver().saver, {
      loadSessionOpenText,
    });
    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-cleanup-success' }),
      successDeps,
    );
    const successPath = (
      successPool.createConversationCalls[0].options as {
        appendSystemPromptFile: string;
      }
    ).appendSystemPromptFile;
    expect(successPath).toBeDefined();
    expect(fs.existsSync(successPath)).toBe(false);

    const errorPool = fakePool({
      sendTurn: async () => ({
        result: { is_error: true, result: 'boom', session_id: 's1' },
        events: [],
        turnEvents: [],
        timing: { totalTurnMs: 1 },
        pid: 1,
      }),
    });
    const errorDeps = historyDeps(errorPool.pool, tempSaver().saver, {
      loadSessionOpenText,
    });
    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-cleanup-error' }),
      errorDeps,
    );
    expect(outcome.status).toBe('error');
    const errorPath = (
      errorPool.createConversationCalls[0].options as {
        appendSystemPromptFile: string;
      }
    ).appendSystemPromptFile;
    expect(errorPath).toBeDefined();
    expect(fs.existsSync(errorPath)).toBe(false);
  });
});

describe('runParentTurnViaCliSubprocess: context-compaction integration (LIA-457)', () => {
  let compactionScratchRoot: string;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (compactionScratchRoot) {
      fs.rmSync(compactionScratchRoot, { recursive: true, force: true });
    }
  });

  /** A pool that dispatches by conversation-id prefix — `cli-summary-*` gets
   *  the summary response, `parent-*` gets the normal turn response — per
   *  the plan's own established test convention for this fixture. */
  function compactionPool(summaryText: string): {
    pool: ClaudeCliSessionPool;
    createConversationCalls: Array<{ id: string; options: unknown }>;
  } {
    const createConversationCalls: Array<{ id: string; options: unknown }> = [];
    const pool = {
      createConversation: vi.fn(async (id: string, options: unknown) => {
        createConversationCalls.push({ id, options });
        return { conversationId: id, pid: 1 };
      }),
      sendTurn: vi.fn(async (id: string) => {
        if (id.startsWith('cli-summary-')) {
          return {
            result: { is_error: false, result: summaryText, session_id: 's1' },
            events: [],
            turnEvents: [],
            timing: { totalTurnMs: 5 },
            pid: 1,
          };
        }
        return {
          result: { is_error: false, result: 'hi there', session_id: 's1' },
          events: [],
          turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
          timing: { totalTurnMs: 10 },
          pid: 1,
        };
      }),
      terminate: vi.fn(async () => {}),
    } as unknown as ClaudeCliSessionPool;
    return { pool, createConversationCalls };
  }

  function compactionDeps(
    pool: ClaudeCliSessionPool,
    saver: BaseCheckpointSaver,
    acquireProcessSlot: () => Promise<ProcessSlotLease | null>,
  ): Parameters<typeof runParentTurnViaCliSubprocess>[1] {
    compactionScratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lia457-parent-compaction-'),
    );
    const { lease } = fakeLease();
    return {
      pool,
      mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
      mcpServerName: MCP_SERVER_NAME,
      repoRoot: '/repo',
      scratchDirFor: (id: string) => path.join(compactionScratchRoot, id),
      saver,
      acquireThreadTurnLease: async () => lease,
      acquireProcessSlot,
    };
  }

  /** Seeds `pairCount` human/ai message pairs directly via
   *  `persistCliCheckpoint`, bypassing the runner entirely. Needed because
   *  `determineCutoffIndex`'s own `findSafeCutoff` returns cutoff `0` (no
   *  compaction possible) whenever the message count is `<=
   *  DEFAULT_COMPACTION_MESSAGES_TO_KEEP` (8) — a low token threshold alone
   *  is not enough to force a real cutoff; there must be more history than
   *  the keep-window to begin with. 5 pairs (10 messages) exceeds it. */
  async function seedPriorMessages(
    saver: BaseCheckpointSaver,
    threadId: string,
    pairCount: number,
  ): Promise<void> {
    const messages: BaseMessage[] = [];
    for (let i = 0; i < pairCount; i++) {
      messages.push(
        new HumanMessage({ id: `seed-h-${i}`, content: `seed question ${i}` }),
      );
      messages.push(
        new AIMessage({ id: `seed-a-${i}`, content: `seed answer ${i}` }),
      );
    }
    await persistCliCheckpoint({
      saver,
      threadId,
      priorTuple: undefined,
      newMessages: messages,
    });
  }

  it('below the (default, real) threshold: compaction never fires, no summary conversation is spawned', async () => {
    const { pool, createConversationCalls } = compactionPool('unused');
    const { saver } = tempSaver();
    const { slot } = fakeSlot();
    const deps = compactionDeps(pool, saver, async () => slot);

    // Two ordinary small turns — nowhere near the real 150k-token default.
    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-no-compaction' }),
      deps,
    );
    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-no-compaction', prompt: 'follow-up' }),
      deps,
    );

    expect(
      createConversationCalls.some((c) => c.id.startsWith('cli-summary-')),
    ).toBe(false);
    expect(
      createConversationCalls.filter((c) => c.id.startsWith('parent-')),
    ).toHaveLength(2);
  });

  it('above a forced low threshold: compacts the history file and persists the compacted baseline + new turn messages', async () => {
    vi.stubEnv(COMPACTION_TOKEN_THRESHOLD_ENV, '1');
    const salientSummary =
      "Here is Deus's compacted conversation summary:\n\nprior context";
    const { pool, createConversationCalls } = compactionPool(salientSummary);
    const { saver } = tempSaver();
    const { slot } = fakeSlot();
    const deps = compactionDeps(pool, saver, async () => slot);
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    // 5 seeded pairs (10 messages) exceeds the default keep-window (8), so
    // there's a real cutoff to compact, not just a token-threshold trigger.
    await seedPriorMessages(saver, 'thread-compacts', 5);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-compacts', prompt: 'follow-up' }),
      deps,
    );
    expect(outcome.status).toBe('success');

    const summaryCall = createConversationCalls.find((c) =>
      c.id.startsWith('cli-summary-'),
    );
    expect(summaryCall).toBeDefined();

    const parentCalls = createConversationCalls.filter((c) =>
      c.id.startsWith('parent-'),
    );
    expect(parentCalls).toHaveLength(1);
    const parentOptions = parentCalls[0].options as {
      appendSystemPromptFile?: string;
    };
    expect(parentOptions.appendSystemPromptFile).toBeDefined();
    const historyWriteCall = writeSpy.mock.calls.find(
      ([writtenPath]) => writtenPath === parentOptions.appendSystemPromptFile,
    );
    const historyContent = historyWriteCall?.[1];
    expect(historyContent).toContain(salientSummary);
    // The earliest seeded pair (summarized away) is gone from the history —
    // replaced by the summary, not appended alongside it.
    expect(historyContent).not.toContain('seed question 0');

    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-compacts', checkpoint_ns: '' },
    });
    const messages = tuple?.checkpoint.channel_values['messages'] as unknown[];
    // 10 seeded messages, keep=8 -> cutoff=2 -> 1 summary + 8 preserved tail
    // + this turn's own 2 new messages (human follow-up + assistant reply)
    // = 11 — NOT the uncompacted 10 + 2 = 12.
    expect(messages).toHaveLength(11);

    writeSpy.mockRestore();
  });

  it('a compacting turn transiently holds 2 slots (summary + parent), acquired in that order, via the SAME injected acquireProcessSlot', async () => {
    vi.stubEnv(COMPACTION_TOKEN_THRESHOLD_ENV, '1');
    const { pool } = compactionPool('a real summary');
    const { saver } = tempSaver();
    const { slot } = fakeSlot();
    const acquireProcessSlot = vi.fn(async () => slot);
    const deps = compactionDeps(pool, saver, acquireProcessSlot);

    await seedPriorMessages(saver, 'thread-slots', 5);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-slots', prompt: 'follow-up' }),
      deps,
    );
    expect(outcome.status).toBe('success');
    // The parent's own slot (acquired first, at the top of the function)
    // PLUS the summary's own slot (acquired second, inside
    // CliSummaryModel._generate once compaction actually fires) — 2 calls
    // through the identical injected function, not a new/separate one.
    expect(acquireProcessSlot).toHaveBeenCalledTimes(2);
  });

  it("null-slot degrade path: the summary's own slot acquisition failing does not fail the turn — it proceeds uncompacted", async () => {
    vi.stubEnv(COMPACTION_TOKEN_THRESHOLD_ENV, '1');
    const { pool, createConversationCalls } = compactionPool('unused summary');
    const { saver } = tempSaver();
    const { slot: parentSlot, releaseCount } = fakeSlot();
    let callCount = 0;
    // Call 1 = the parent's own slot (acquired before priorMessages is even
    // read) -> succeeds. Call 2 = the summary's slot (only reached if
    // compaction's dry run actually fires) -> exhausted, returns null.
    const acquireProcessSlot = vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? parentSlot : null;
    });
    const deps = compactionDeps(pool, saver, acquireProcessSlot);

    await seedPriorMessages(saver, 'thread-null-slot', 5);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-null-slot', prompt: 'follow-up' }),
      deps,
    );

    // The turn itself still succeeds -- degrade, not failure. No hang, no
    // thrown error escaping the runner.
    expect(outcome.status).toBe('success');
    expect(
      createConversationCalls.some((c) => c.id.startsWith('cli-summary-')),
    ).toBe(false); // the summary conversation itself was never spawned
    expect(
      createConversationCalls.filter((c) => c.id.startsWith('parent-')),
    ).toHaveLength(1);
    // The parent's own slot (call 1) was released normally -- the null-slot
    // failure was fully contained inside the compaction dry run.
    expect(releaseCount()).toBe(1);
  });
});

describe('runParentTurnViaCliSubprocess: control-group memory-recall (LIA-458)', () => {
  it('appends recalledMemoryContext to the LIVE prompt sent to the CLI, while the persisted current-turn message stays the bare, unaugmented prompt', async () => {
    let capturedLivePrompt: string | undefined;
    const { pool } = fakePool({
      sendTurn: async (id, prompt) => {
        capturedLivePrompt = prompt;
        return {
          result: { is_error: false, result: 'hi there', session_id: 's1' },
          events: [],
          turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
          timing: { totalTurnMs: 10 },
          pid: 1,
        };
      },
    });
    const { saver } = tempSaver();
    const { lease } = fakeLease();
    const { slot } = fakeSlot();

    await runParentTurnViaCliSubprocess(
      baseOptions({
        prompt: 'what is the weather',
        recalledMemoryContext: 'recalled: user likes cats',
      }),
      baseDeps(pool, saver, lease, slot),
    );

    expect(capturedLivePrompt).toBe(
      'what is the weather\n\nrecalled: user likes cats',
    );

    // The persisted current-turn HumanMessage is the bare prompt, NOT the
    // augmented live string -- this is the exact split round-1 plan-review
    // caught missing (recalled context reaching only the checkpoint, never
    // this same turn's live CLI call).
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-1', checkpoint_ns: '' },
    });
    const messages = tuple?.checkpoint.channel_values[
      'messages'
    ] as BaseMessage[];
    const currentTurnMessage = messages.find(
      (m) => m.id === 'msg_1',
    ) as HumanMessage;
    expect(currentTurnMessage.content).toBe('what is the weather');

    // The recalled context still separately persists (pre-existing,
    // unchanged mechanism) as its own HumanMessage, for next-turn history.
    expect(
      messages.some((m) => m.content === 'recalled: user likes cats'),
    ).toBe(true);
  });

  it('omitted/empty recalledMemoryContext leaves the live prompt byte-identical to today', async () => {
    let capturedLivePrompt: string | undefined;
    const { pool } = fakePool({
      sendTurn: async (id, prompt) => {
        capturedLivePrompt = prompt;
        return {
          result: { is_error: false, result: 'hi there', session_id: 's1' },
          events: [],
          turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
          timing: { totalTurnMs: 10 },
          pid: 1,
        };
      },
    });
    const { saver } = tempSaver();
    const { lease } = fakeLease();
    const { slot } = fakeSlot();

    await runParentTurnViaCliSubprocess(
      baseOptions({ prompt: 'hello, no recall' }),
      baseDeps(pool, saver, lease, slot),
    );
    expect(capturedLivePrompt).toBe('hello, no recall');

    // Empty string is a no-op too, same as undefined.
    await runParentTurnViaCliSubprocess(
      baseOptions({
        threadId: 'thread-2',
        prompt: 'hello again',
        recalledMemoryContext: '',
      }),
      baseDeps(pool, saver, lease, slot),
    );
    expect(capturedLivePrompt).toBe('hello again');
  });
});

describe('runParentTurnViaCliSubprocess: nested-dispatch usage side channel (LIA-460)', () => {
  let usageScratchRoot: string;
  afterEach(() => {
    if (usageScratchRoot) {
      fs.rmSync(usageScratchRoot, { recursive: true, force: true });
    }
  });

  function usageDeps(
    pool: ClaudeCliSessionPool,
    saver: BaseCheckpointSaver,
  ): Parameters<typeof runParentTurnViaCliSubprocess>[1] {
    usageScratchRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lia460-parent-usage-'),
    );
    const { lease } = fakeLease();
    const { slot } = fakeSlot();
    return {
      pool,
      mcpServerScriptPath: '/repo/parent-turn-mcp-server.ts',
      mcpServerName: MCP_SERVER_NAME,
      repoRoot: '/repo',
      scratchDirFor: (id: string) => path.join(usageScratchRoot, id),
      saver,
      acquireThreadTurnLease: async () => lease,
      acquireProcessSlot: async () => slot,
    };
  }

  it('sets DEUS_PARENT_SCRATCH_DIR to the exact same scratchDir passed to createConversation', async () => {
    const { pool, createConversationCalls } = fakePool();
    const { saver } = tempSaver();
    const deps = usageDeps(pool, saver);

    await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-scratch-env' }),
      deps,
    );

    const options = createConversationCalls[0].options as {
      scratchDir: string;
      mcpServerEnv: Record<string, string>;
    };
    expect(options.mcpServerEnv.DEUS_PARENT_SCRATCH_DIR).toBe(
      options.scratchDir,
    );
  });

  it('no usage file present -> nestedUsageEvents is [] (the common case: no nested dispatch happened this turn)', async () => {
    const { pool } = fakePool();
    const { saver } = tempSaver();
    const deps = usageDeps(pool, saver);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-no-usage-file' }),
      deps,
    );

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.nestedUsageEvents).toEqual([]);
    }
  });

  it('a usage file written to the SAME scratchDir before the turn completes is read back and cleared', async () => {
    // Simulates the MCP server subprocess having already appended a nested
    // child's usage to the shared scratch directory before the parent's own
    // sendTurn() resolves -- proving the reader picks up whatever the writer
    // left there, using the identical directory this function itself
    // computes (no separate path derivation to drift apart).
    const conversationId = 'parent-thread-with-usage-1';
    const scratchDirForConversation = (root: string) =>
      path.join(root, conversationId);

    let usageDepsResolved:
      Parameters<typeof runParentTurnViaCliSubprocess>[1] | undefined;
    const { pool } = fakePool({
      sendTurn: async (id, prompt) => {
        // Write the nested-dispatch usage file into the SAME scratchDir the
        // real MCP server subprocess would use, right before this fake
        // "CLI turn" resolves -- matching the real ordering (child dispatch
        // completes and writes its usage during the parent's own sendTurn).
        if (usageDepsResolved !== undefined) {
          const dir = usageDepsResolved.scratchDirFor(id);
          appendNestedDispatchUsage(dir, {
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            inputTokens: 29_794,
            outputTokens: 5,
            totalTokens: 29_799,
          });
        }
        return {
          result: { is_error: false, result: 'hi there', session_id: 's1' },
          events: [],
          turnEvents: [assistantTextEvent('hi there'), resultEvent('hi there')],
          timing: { totalTurnMs: 10 },
          pid: 1,
        };
      },
    });
    const { saver } = tempSaver();
    usageDepsResolved = usageDeps(pool, saver);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-with-usage' }),
      usageDepsResolved,
    );

    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.nestedUsageEvents).toEqual([
        {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          inputTokens: 29_794,
          outputTokens: 5,
          totalTokens: 29_799,
        },
      ]);
    }
  });

  it('code-review finding: a usage file written before the turn ultimately ERRORS is still cleaned up in the finally block, never orphaned', async () => {
    let usageDepsResolved:
      Parameters<typeof runParentTurnViaCliSubprocess>[1] | undefined;
    let usageFilePathAtWriteTime: string | undefined;
    let existedRightAfterWrite: boolean | undefined;
    const { pool } = fakePool({
      sendTurn: async (id) => {
        // A nested dispatch already wrote usage before this turn's OWN
        // is_error result comes back -- the exact scenario the pre-fix code
        // silently orphaned (only the success-path return ever called
        // readAndClearNestedDispatchUsage).
        if (usageDepsResolved !== undefined) {
          const dir = usageDepsResolved.scratchDirFor(id);
          appendNestedDispatchUsage(dir, {
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            inputTokens: 12_345,
            outputTokens: 1,
            totalTokens: 12_346,
          });
          usageFilePathAtWriteTime = path.join(
            dir,
            NESTED_DISPATCH_USAGE_FILENAME,
          );
          // Proves the write genuinely landed on disk -- otherwise a later
          // "file doesn't exist" assertion would be meaningless (it could
          // mean either "cleaned up" or "never written").
          existedRightAfterWrite = fs.existsSync(usageFilePathAtWriteTime);
        }
        return {
          result: { is_error: true, result: 'boom', session_id: 's1' },
          events: [],
          turnEvents: [],
          timing: { totalTurnMs: 5 },
          pid: 1,
        };
      },
    });
    const { saver } = tempSaver();
    usageDepsResolved = usageDeps(pool, saver);

    const outcome = await runParentTurnViaCliSubprocess(
      baseOptions({ threadId: 'thread-usage-then-error' }),
      usageDepsResolved,
    );
    expect(outcome.status).toBe('error');
    expect(existedRightAfterWrite).toBe(true);
    expect(usageFilePathAtWriteTime).toBeDefined();
    expect(fs.existsSync(usageFilePathAtWriteTime!)).toBe(false);
  });
});
