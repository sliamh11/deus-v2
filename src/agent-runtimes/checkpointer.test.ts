/**
 * B4 (LIA-404): unit tests for the checkpointer singleton module.
 *
 * NO module mocking is used for getCheckpointer/_resetCheckpointerForTests —
 * getCheckpointer's path is parameter-injected directly, sidestepping the
 * same-module-mock pitfall entirely (mocking the exported
 * resolveCheckpointerDbPath would NOT rewire getCheckpointer's internal
 * same-file call in ESM/Vitest; see checkpointer.ts's own doc comment).
 *
 * Every test that constructs a saver MUST pass an explicit dbPathOverride
 * from fs.mkdtempSync — never call getCheckpointer() with no argument here:
 * `store/` does not exist in this worktree/on a clean checkout,
 * SqliteSaver.fromConnString opens its file EAGERLY at construction, and
 * better-sqlite3 does not create missing parent directories, so a
 * no-argument call would throw or silently touch a real, production-adjacent
 * path.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Checkpoint,
  CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';

import {
  resolveCheckpointerDbPath,
  getCheckpointer,
  _resetCheckpointerForTests,
} from './checkpointer.js';

// Legitimate CROSS-module mock (config.ts is a genuinely different file from
// checkpointer.ts — same class of mock as lifecycle-events.test.ts's
// group-folder.js mock), used ONLY by the pure resolveCheckpointerDbPath
// test below.
const { MOCKED_STORE_DIR } = vi.hoisted(() => ({
  MOCKED_STORE_DIR: '/mocked-store-dir-for-b4-tests',
}));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    STORE_DIR: MOCKED_STORE_DIR,
  };
});

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-checkpointer-'));
  tempDirs.push(dir);
  return path.join(dir, 'checkpoints.db');
}

/** Minimal valid checkpoint tuple pieces for driving a real put/getTuple. */
function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: { messages: [] },
    channel_versions: {},
    versions_seen: {},
  } as Checkpoint;
}

const METADATA: CheckpointMetadata = {
  source: 'input',
  step: -1,
  parents: {},
};

beforeEach(() => {
  _resetCheckpointerForTests();
});

afterEach(() => {
  _resetCheckpointerForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCheckpointerDbPath', () => {
  it('returns checkpoints.db inside STORE_DIR', () => {
    const resolved = resolveCheckpointerDbPath();
    expect(resolved).toBe(path.join(MOCKED_STORE_DIR, 'checkpoints.db'));
    expect(path.basename(resolved)).toBe('checkpoints.db');
  });
});

describe('getCheckpointer', () => {
  it('memoizes: two calls with the same explicit dbPathOverride return the exact same instance', () => {
    const dbPath = tempDbPath();
    const first = getCheckpointer(dbPath);
    const second = getCheckpointer(dbPath);
    // toBe (identity), not toEqual — proving the singleton, not just "a
    // working saver".
    expect(second).toBe(first);
  });

  it('_resetCheckpointerForTests genuinely un-memoizes and the fresh instance writes to the NEW file', async () => {
    const dbPathA = tempDbPath();
    const dbPathB = tempDbPath();

    const saverA = getCheckpointer(dbPathA);
    _resetCheckpointerForTests();
    const saverB = getCheckpointer(dbPathB);
    expect(saverB).not.toBe(saverA);

    // Write a checkpoint through saverB and prove it landed in dbPathB's
    // file, not dbPathA's — via fresh instances opened against each path
    // (the module's own reset + override API, no direct SqliteSaver use).
    const threadConfig = {
      configurable: { thread_id: 'reset-test-thread', checkpoint_ns: '' },
    };
    await saverB.put(
      threadConfig,
      makeCheckpoint('00000000-0000-0000-0000-000000000001'),
      METADATA,
      // newVersions (BaseCheckpointSaver's abstract signature requires it;
      // SqliteSaver ignores it) — empty is valid for an empty checkpoint.
      {},
    );

    _resetCheckpointerForTests();
    const freshOnA = getCheckpointer(dbPathA);
    expect(
      await freshOnA.getTuple({
        configurable: { thread_id: 'reset-test-thread' },
      }),
    ).toBeUndefined();

    _resetCheckpointerForTests();
    const freshOnB = getCheckpointer(dbPathB);
    const tuple = await freshOnB.getTuple({
      configurable: { thread_id: 'reset-test-thread' },
    });
    expect(tuple).toBeDefined();
    expect(tuple?.checkpoint.id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('memoization wins over a different override argument on a later call', () => {
    const dbPathA = tempDbPath();
    const dbPathB = tempDbPath();
    const first = getCheckpointer(dbPathA);
    // Without a reset, the SECOND call's different argument is ignored —
    // only the first call's argument determines the underlying file. This is
    // the exact semantics the integration suites depend on
    // (_resetCheckpointerForTests in beforeEach, or a stale file wins).
    const second = getCheckpointer(dbPathB);
    expect(second).toBe(first);
  });
});
