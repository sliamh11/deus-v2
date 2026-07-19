/**
 * LIA-454 EP-002 step 6: CliSummaryModel unit tests.
 *
 * Hermetic — a FAKE spawnFn (same pattern as `claude-cli-session-pool.test.ts`),
 * never a real subprocess. The real end-to-end proof (real CLI + real
 * SqliteSaver + real compaction trigger) lives in
 * `context-compaction.cli-integration.test.ts`.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

import {
  ClaudeCliSessionPool,
  type ChildProcessLike,
  type ProcessControlFns,
  type SpawnFn,
} from './claude-cli-session-pool.js';
import { CliSummaryModel, CliSummaryModelError } from './cli-summary-model.js';

class FakeWritable extends EventEmitter {
  written: string[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {}
}
class FakeReadable extends EventEmitter {}
class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  alive = true;
  constructor(public readonly pid: number) {
    super();
  }
  emitStdout(chunk: string): void {
    this.stdout.emit('data', chunk);
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.alive = false;
    this.emit('exit', code, signal);
  }
}

/**
 * A fake `processControl` is REQUIRED whenever the code under test can call
 * `pool.terminate()` (as `CliSummaryModel._generate`'s `finally` always
 * does) — the pool's real default (`defaultProcessControlFns`) issues an
 * actual `process.kill(-pid, ...)` POSIX process-GROUP signal. With a fake
 * numeric pid like `1`, that's `process.kill(-1, ...)`, a broadcast signal
 * to every process the caller can signal — caught here (it errored out
 * harmlessly under this sandbox's permissions rather than affecting real
 * processes, but must never be exercised un-faked). Mirrors
 * `claude-cli-session-pool.test.ts`'s own `createFakeProcessControl`.
 */
function createFakeProcessControl(
  childrenByPid: Map<number, FakeChildProcess>,
): ProcessControlFns {
  return {
    exists: (pid) => childrenByPid.get(pid)?.alive ?? false,
    kill: (pid) => childrenByPid.get(pid)?.emitExit(null, 'SIGTERM'),
    forceKill: (pid) => childrenByPid.get(pid)?.emitExit(null, 'SIGKILL'),
  };
}

function createFakeSpawnFn(children: FakeChildProcess[]): {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  let index = 0;
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn: SpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = children[index];
    index += 1;
    if (child === undefined) throw new Error('not enough fake children queued');
    return child;
  };
  return { spawnFn, calls };
}

/** Polls until the CLI turn's stdin write actually lands — `model.invoke()`
 *  chains through several async layers (generatePrompt -> generate ->
 *  _generate -> createConversation's own spawn-error-detection tick ->
 *  sendTurn) before the write happens, so a single fixed `setImmediate`
 *  isn't reliably enough hops; this waits exactly as long as needed. */
async function waitForWrite(child: FakeChildProcess): Promise<void> {
  while (child.stdin.written.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function resultLine(text: string, isError = false): string {
  return (
    JSON.stringify({
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      session_id: 's1',
      ...(isError ? {} : { result: text }),
    }) + '\n'
  );
}

let scratchRoot: string;
const repoRoot = process.cwd();

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lia454-summary-model-'));
});
afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('CliSummaryModel', () => {
  it('invokes the CLI with the string prompt and returns an AIMessage carrying the result text', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn, calls } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
      processControl: createFakeProcessControl(new Map([[1, child]])),
    });
    const model = new CliSummaryModel({
      pool,
      model: 'claude-sonnet-5',
      repoRoot,
      scratchDirFor: (id) => path.join(scratchRoot, id),
    });

    const invokePromise = model.invoke('summarize: turn 1, turn 2');
    await waitForWrite(child);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).not.toContain('--mcp-config');
    expect(calls[0].args).not.toContain('--allowedTools');
    expect(calls[0].args.slice(-2)).toEqual(['--model', 'claude-sonnet-5']);

    const written = JSON.parse(child.stdin.written[0]);
    expect(written.message.content).toBe('summarize: turn 1, turn 2');

    child.emitStdout(resultLine('Here is the continuity summary.'));
    const response = await invokePromise;
    expect(response.content).toBe('Here is the continuity summary.');
  });

  it('flattens multiple/non-string messages defensively rather than assuming a single string prompt', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
      processControl: createFakeProcessControl(new Map([[1, child]])),
    });
    const model = new CliSummaryModel({
      pool,
      model: 'claude-sonnet-5',
      repoRoot,
      scratchDirFor: (id) => path.join(scratchRoot, id),
    });

    const invokePromise = model.invoke([
      new HumanMessage('part one'),
      new HumanMessage('part two'),
    ]);
    await waitForWrite(child);
    const written = JSON.parse(child.stdin.written[0]);
    expect(written.message.content).toBe('part one\npart two');

    child.emitStdout(resultLine('ok'));
    await invokePromise;
  });

  it('terminates the conversation even when the CLI turn errors, and rejects with CliSummaryModelError', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const terminatedIds: string[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => {
        if (
          e.type === 'termination_requested' &&
          e.conversationId !== undefined
        )
          terminatedIds.push(e.conversationId);
      },
      spawnFn,
      processControl: createFakeProcessControl(new Map([[1, child]])),
    });
    const model = new CliSummaryModel({
      pool,
      model: 'claude-sonnet-5',
      repoRoot,
      scratchDirFor: (id) => path.join(scratchRoot, id),
    });

    const invokePromise = model.invoke('will fail');
    await waitForWrite(child);
    child.emitStdout(resultLine('', true));

    await expect(invokePromise).rejects.toThrow(CliSummaryModelError);
    expect(terminatedIds).toHaveLength(1);
  });

  it('terminates the conversation on a successful turn too — never leaves a lingering process', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const terminatedIds: string[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => {
        if (
          e.type === 'termination_requested' &&
          e.conversationId !== undefined
        )
          terminatedIds.push(e.conversationId);
      },
      spawnFn,
      processControl: createFakeProcessControl(new Map([[1, child]])),
    });
    const model = new CliSummaryModel({
      pool,
      model: 'claude-sonnet-5',
      repoRoot,
      scratchDirFor: (id) => path.join(scratchRoot, id),
    });

    const invokePromise = model.invoke('summarize');
    await waitForWrite(child);
    child.emitStdout(resultLine('done'));
    await invokePromise;

    expect(terminatedIds).toHaveLength(1);
  });
});
