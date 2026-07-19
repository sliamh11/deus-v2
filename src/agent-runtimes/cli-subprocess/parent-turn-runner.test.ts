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

let scratchRoot: string;
afterEach(() => {
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function tempSaver(): { saver: SqliteSaver; dir: string } {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia454-parent-turn-runner-'),
  );
  scratchRoot = dir;
  const dbPath = path.join(dir, 'checkpoints.db');
  return { saver: SqliteSaver.fromConnString(dbPath), dir };
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
