import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeCliSessionError,
  ClaudeCliSessionPool,
  assertNoAmbiguousAuthOverride,
  buildChildEnv,
  buildClaudeCliArgs,
  buildMcpScratchConfig,
  resolveTsxLoaderPath,
  type ChildProcessLike,
  type ProcessControlFns,
  type SessionLifecycleEvent,
  type SpawnFn,
} from './claude-cli-session-pool.js';

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeWritable extends EventEmitter {
  written: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
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

  emitStdout(chunk: string | Buffer): void {
    this.stdout.emit('data', chunk);
  }

  emitStderr(text: string): void {
    this.stderr.emit('data', text);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.alive = false;
    this.emit('exit', code, signal);
  }

  emitError(err: Error): void {
    this.emit('error', err);
  }
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
    if (child === undefined) {
      throw new Error('createFakeSpawnFn: not enough fake children queued');
    }
    return child;
  };
  return { spawnFn, calls };
}

interface FakeProcessControlOptions {
  /** If true, `kill` (SIGTERM) never actually terminates the fake child —
   *  simulates an unresponsive process requiring SIGKILL escalation. */
  ignoreSigterm?: boolean;
}

function createFakeProcessControl(
  childrenByPid: Map<number, FakeChildProcess>,
  options: FakeProcessControlOptions = {},
): ProcessControlFns & { forceKillCalls: number[]; killCalls: number[] } {
  const killCalls: number[] = [];
  const forceKillCalls: number[] = [];
  return {
    killCalls,
    forceKillCalls,
    exists: (pid) => childrenByPid.get(pid)?.alive ?? false,
    kill: (pid) => {
      killCalls.push(pid);
      const child = childrenByPid.get(pid);
      if (child === undefined || options.ignoreSigterm) return;
      child.emitExit(null, 'SIGTERM');
    },
    forceKill: (pid) => {
      forceKillCalls.push(pid);
      const child = childrenByPid.get(pid);
      if (child === undefined) return;
      child.emitExit(null, 'SIGKILL');
    },
  };
}

let scratchDir: string;
const repoRoot = process.cwd();
const dummyServerScriptPath = '/dummy/permission-check-mcp-server.ts';

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia449-pool-test-'));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function createOptionsFor(id: string) {
  return {
    scratchDir: path.join(scratchDir, id),
    mcpServerName: 'deus_lia449',
    mcpServerScriptPath: dummyServerScriptPath,
    repoRoot,
    allowedTool: 'mcp__deus_lia449__check_permission',
  };
}

const SYSTEM_INIT_LINE =
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    mcp_servers: [{ name: 'deus_lia449', status: 'connected' }],
    tools: ['mcp__deus_lia449__check_permission'],
  }) + '\n';

function resultLine(text: string): string {
  return (
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      result: text,
    }) + '\n'
  );
}

// ── Pure helper functions ────────────────────────────────────────────────

describe('buildChildEnv / assertNoAmbiguousAuthOverride', () => {
  it('strips CLAUDECODE and NODE_OPTIONS, preserves everything else', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      CLAUDECODE: '1',
      NODE_OPTIONS: '--foo',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
  });

  it('throws when an ambiguous auth env var is set', () => {
    expect(() =>
      assertNoAmbiguousAuthOverride({ ANTHROPIC_API_KEY: 'sk-x' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('does not throw when no ambiguous auth vars are set', () => {
    expect(() =>
      assertNoAmbiguousAuthOverride({ PATH: '/usr/bin' }),
    ).not.toThrow();
  });
});

describe('resolveTsxLoaderPath / buildMcpScratchConfig', () => {
  it('resolves an absolute path ending in dist/loader.mjs (the "." export, not esm/api)', () => {
    const loaderPath = resolveTsxLoaderPath(repoRoot);
    expect(path.isAbsolute(loaderPath)).toBe(true);
    expect(loaderPath.endsWith(path.join('dist', 'loader.mjs'))).toBe(true);
    expect(loaderPath).not.toContain(path.join('esm', 'api'));
  });

  it('builds a scratch config with an absolute --import path (never a bare "tsx")', () => {
    const config = buildMcpScratchConfig({
      serverName: 'deus_lia449',
      serverScriptPath: dummyServerScriptPath,
      repoRoot,
    });
    const entry = config.mcpServers.deus_lia449;
    expect(entry.type).toBe('stdio');
    expect(entry.args[0]).toBe('--import');
    expect(path.isAbsolute(entry.args[1])).toBe(true);
    expect(entry.args[2]).toBe(dummyServerScriptPath);
    expect(entry.env).toBeUndefined();
  });

  it('LIA-454: omits env when serverEnv is not supplied (default-unchanged)', () => {
    const config = buildMcpScratchConfig({
      serverName: 'deus_lia454',
      serverScriptPath: dummyServerScriptPath,
      repoRoot,
    });
    expect(config.mcpServers.deus_lia454.env).toBeUndefined();
  });

  it('LIA-454: threads serverEnv through to the per-server config entry', () => {
    const config = buildMcpScratchConfig({
      serverName: 'deus_lia454',
      serverScriptPath: dummyServerScriptPath,
      repoRoot,
      serverEnv: {
        DEUS_NESTED_DISPATCH_CONTEXT: '{"permissionProfile":"default"}',
      },
    });
    expect(config.mcpServers.deus_lia454.env).toEqual({
      DEUS_NESTED_DISPATCH_CONTEXT: '{"permissionProfile":"default"}',
    });
  });
});

describe('buildClaudeCliArgs', () => {
  it('includes every flag the plan depends on, in the documented shape', () => {
    const args = buildClaudeCliArgs({
      mcpConfigPath: '/scratch/mcp-config.json',
      allowedTool: 'mcp__deus_lia449__check_permission',
    });
    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      '/scratch/mcp-config.json',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--tools',
      '',
      '--allowedTools',
      'mcp__deus_lia449__check_permission',
      '--permission-mode',
      'dontAsk',
    ]);
  });

  it('LIA-454: omits --model when not supplied (default-unchanged)', () => {
    const args = buildClaudeCliArgs({
      mcpConfigPath: '/scratch/mcp-config.json',
      allowedTool: 'mcp__deus_lia449__check_permission',
    });
    expect(args).not.toContain('--model');
  });

  it('LIA-454: appends --model <id> when a model is supplied', () => {
    const args = buildClaudeCliArgs({
      mcpConfigPath: '/scratch/mcp-config.json',
      allowedTool: 'mcp__deus_lia449__check_permission',
      model: 'claude-sonnet-5',
    });
    expect(args.slice(-2)).toEqual(['--model', 'claude-sonnet-5']);
  });
});

// ── Checkpoint 2: spawn + single-turn round-trip ─────────────────────────

describe('ClaudeCliSessionPool: spawn + single-turn round-trip', () => {
  it('spawns via the injected fake spawn fn and emits "spawned" with the fake pid', async () => {
    const child = new FakeChildProcess(4242);
    const { spawnFn, calls } = createFakeSpawnFn([child]);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
      claudeBin: 'claude',
    });

    const handle = await pool.createConversation(
      'conv-a',
      createOptionsFor('a'),
    );

    expect(handle).toEqual({ conversationId: 'conv-a', pid: 4242 });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toContain('--strict-mcp-config');
    expect(events.map((e) => e.type)).toEqual(['spawned']);
    expect(events[0].pid).toBe(4242);
  });

  it('sendTurn writes exactly one NDJSON line matching the SDKUserMessage envelope', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));

    const turnPromise = pool.sendTurn('conv-a', 'hello world');
    expect(child.stdin.written).toEqual([
      '{"type":"user","message":{"role":"user","content":"hello world"},"parent_tool_use_id":null,"session_id":""}\n',
    ]);

    child.emitStdout(SYSTEM_INIT_LINE);
    child.emitStdout(resultLine('hi'));
    const turnResult = await turnPromise;
    expect(turnResult.result.result).toBe('hi');
    expect(turnResult.pid).toBe(1);
  });

  it('TurnResult.events includes the session system/init event alongside the result', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    child.emitStdout(SYSTEM_INIT_LINE); // arrives before any turn is sent
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    child.emitStdout(resultLine('ok'));
    const resolved = await turnPromise;
    expect(
      resolved.events.some(
        (e) => e.type === 'system' && e['subtype'] === 'init',
      ),
    ).toBe(true);
    expect(resolved.events.some((e) => e.type === 'result')).toBe(true);
  });

  it('reassembles a result line split across multiple stdout chunks', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    const full = resultLine('split-ok');
    child.emitStdout(full.slice(0, 10));
    child.emitStdout(full.slice(10, 20));
    child.emitStdout(full.slice(20));
    const result = await turnPromise;
    expect(result.result.result).toBe('split-ok');
  });

  it('decodes a multi-byte UTF-8 character split across a raw stdout Buffer boundary', async () => {
    // Regression test: decoding each Buffer independently with
    // `chunk.toString('utf8')` corrupts a multi-byte character whose bytes
    // straddle a chunk boundary (produces U+FFFD replacement characters,
    // which then breaks JSON.parse on the reassembled line). The fix
    // decodes through a persistent `StringDecoder` per stream instead.
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');

    // "🎉" is the 4-byte UTF-8 sequence F0 9F 8E 89 — split it 2/2 bytes
    // across two raw Buffer chunks (a string-slice split, as in the test
    // above, can never reproduce this: string slicing operates on UTF-16
    // code units, not raw bytes).
    const full = Buffer.from(resultLine('done \u{1F389}'), 'utf8');
    const splitIndex = full.indexOf(0xf0); // start of the 4-byte sequence
    child.emitStdout(full.subarray(0, splitIndex + 2));
    child.emitStdout(full.subarray(splitIndex + 2));

    const result = await turnPromise;
    expect(result.result.result).toBe('done \u{1F389}');
  });

  it('rejects an overlapping turn on the same conversation instead of interleaving prompts', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const first = pool.sendTurn('conv-a', 'first');
    await expect(pool.sendTurn('conv-a', 'second')).rejects.toMatchObject({
      code: 'busy',
    });
    // First turn is unaffected — only one stdin write happened.
    expect(child.stdin.written).toHaveLength(1);
    child.emitStdout(resultLine('first-done'));
    await expect(first).resolves.toMatchObject({
      result: { result: 'first-done' },
    });
  });

  it('surfaces a non-empty malformed stdout line as a rejected turn, not silent noise', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    child.emitStdout('not valid json at all\n');
    await expect(turnPromise).rejects.toMatchObject({ code: 'protocol_error' });
    // The failure is retained as evidence, not dropped.
    expect(
      pool.getEvents('conv-a').some((e) => e.type === '_protocol_error'),
    ).toBe(true);
  });

  it('rejects sendTurn for an unknown conversation id', async () => {
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn: createFakeSpawnFn([]).spawnFn,
    });
    await expect(pool.sendTurn('nope', 'hi')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ── Checkpoint 3: lifecycle behaviors ─────────────────────────────────────

describe('ClaudeCliSessionPool: concurrency cap', () => {
  it('rejects a second conversation over the cap without spawning, and emits concurrency_rejected', async () => {
    const childA = new FakeChildProcess(1);
    const { spawnFn, calls } = createFakeSpawnFn([childA]);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    await expect(
      pool.createConversation('conv-b', createOptionsFor('b')),
    ).rejects.toMatchObject({ code: 'capacity_exceeded' });

    expect(calls).toHaveLength(1); // conv-b never actually spawned
    expect(events.map((e) => e.type)).toEqual([
      'spawned',
      'concurrency_rejected',
    ]);
    expect(pool.occupiedSlots).toBe(1);
  });

  it('frees the slot on exit, allowing a new conversation to spawn', async () => {
    const childA = new FakeChildProcess(1);
    const childB = new FakeChildProcess(2);
    const { spawnFn } = createFakeSpawnFn([childA, childB]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    expect(pool.occupiedSlots).toBe(1);
    childA.emitExit(0, null);
    expect(pool.occupiedSlots).toBe(0);
    const handle = await pool.createConversation(
      'conv-b',
      createOptionsFor('b'),
    );
    expect(handle.pid).toBe(2);
    expect(pool.occupiedSlots).toBe(1);
  });
});

describe('ClaudeCliSessionPool: crash/exit surfacing', () => {
  it('rejects a pending turn and emits unexpected_exit then exited on an unrequested crash', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    child.emitExit(1, null); // crash, nobody asked for this

    await expect(turnPromise).rejects.toMatchObject({
      code: 'unexpected_exit',
      detail: { exitCode: 1, signal: null },
    });
    expect(
      events.map((e) => e.type).filter((t) => t !== 'turn_started'),
    ).toEqual(['spawned', 'unexpected_exit', 'exited']);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('surfaces a spawn-time process error even with no turn pending', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    child.emitError(new Error('boom'));
    expect(events.map((e) => e.type)).toEqual([
      'spawned',
      'unexpected_exit',
      'exited',
    ]);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('finalizes exactly once on a double exit (idempotent finalization)', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    child.emit('exit', 1, null);
    child.emit('exit', 1, null); // duplicate — must be a no-op
    expect(events.filter((e) => e.type === 'exited')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'unexpected_exit')).toHaveLength(1);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('rejects createConversation when spawn fails immediately (e.g. ENOENT)', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    const createPromise = pool.createConversation(
      'conv-a',
      createOptionsFor('a'),
    );
    child.emitError(new Error('spawn claude ENOENT'));
    await expect(createPromise).rejects.toMatchObject({ code: 'spawn_error' });
    expect(pool.occupiedSlots).toBe(0);
  });
});

describe('ClaudeCliSessionPool: idle reap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps an idle session after idleTimeoutMs and emits idle_reaped then exited', async () => {
    const child = new FakeChildProcess(7);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[7, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 1000,
      terminationGraceMs: 100,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));

    await vi.advanceTimersByTimeAsync(1000); // idle timer fires
    await vi.advanceTimersByTimeAsync(100); // grace wait before SIGTERM
    // kill() synchronously drives the fake child's exit in this fake control.

    expect(events.map((e) => e.type)).toEqual([
      'spawned',
      'idle_reaped',
      'exited',
    ]);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('pauses the idle timer during an active turn (does not reap mid-turn)', async () => {
    const child = new FakeChildProcess(7);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[7, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 1000,
      terminationGraceMs: 100,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    await vi.advanceTimersByTimeAsync(5000); // far past idleTimeoutMs
    expect(events.some((e) => e.type === 'idle_reaped')).toBe(false);
    child.emitStdout(resultLine('still-alive'));
    await expect(turnPromise).resolves.toMatchObject({
      result: { result: 'still-alive' },
    });
  });

  it('rearms the idle timer after a turn completes', async () => {
    const child = new FakeChildProcess(7);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[7, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 1000,
      terminationGraceMs: 100,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    const turnPromise = pool.sendTurn('conv-a', 'hi');
    child.emitStdout(resultLine('done'));
    await turnPromise;

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.some((e) => e.type === 'idle_reaped')).toBe(true);
  });
});

describe('ClaudeCliSessionPool: SIGTERM-to-force-kill escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates to forceKill when the process ignores SIGTERM', async () => {
    const child = new FakeChildProcess(9);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[9, child]]);
    const processControl = createFakeProcessControl(childrenByPid, {
      ignoreSigterm: true,
    });
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 1000,
      terminationGraceMs: 100,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));

    await vi.advanceTimersByTimeAsync(1000); // idle fires
    await vi.advanceTimersByTimeAsync(100); // grace before SIGTERM -> kill() called, ignored
    expect(processControl.killCalls).toEqual([9]);
    expect(processControl.forceKillCalls).toEqual([]); // not yet — second grace still pending

    await vi.advanceTimersByTimeAsync(100); // second grace -> escalate
    expect(processControl.forceKillCalls).toEqual([9]);
    expect(events.map((e) => e.type)).toEqual([
      'spawned',
      'idle_reaped',
      'exited',
    ]);
  });
});

describe('ClaudeCliSessionPool: shutdownAll / parent cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gracefully tears down every live session and emits termination_requested + cleanup_complete', async () => {
    const childA = new FakeChildProcess(1);
    const childB = new FakeChildProcess(2);
    const { spawnFn } = createFakeSpawnFn([childA, childB]);
    const childrenByPid = new Map([
      [1, childA],
      [2, childB],
    ]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 2,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    await pool.createConversation('conv-b', createOptionsFor('b'));

    const shutdownPromise = pool.shutdownAll();
    await vi.advanceTimersByTimeAsync(50); // grace before SIGTERM
    await shutdownPromise;

    expect(childA.stdin.ended).toBe(true);
    expect(childB.stdin.ended).toBe(true);
    expect(
      events.filter((e) => e.type === 'termination_requested'),
    ).toHaveLength(2);
    expect(events.filter((e) => e.type === 'exited')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'cleanup_complete')).toHaveLength(1);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('is idempotent — a second call returns without re-running teardown', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[1, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));

    const first = pool.shutdownAll();
    const second = pool.shutdownAll();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(events.filter((e) => e.type === 'cleanup_complete')).toHaveLength(1);
  });

  it('shutdownAll does not resolve until the real exit event fires, even after forceKill is sent', async () => {
    // Regression test: terminateSession previously returned immediately
    // after CALLING forceKill, without awaiting the process's actual exit --
    // sending a kill signal is fire-and-forget; the OS reaping the process
    // and Node's 'exit' event firing happens asynchronously, not
    // synchronously with the signal. A fake whose kill/forceKill mocks call
    // `emitExit` SYNCHRONOUSLY (as `createFakeProcessControl` does
    // elsewhere in this file) cannot expose this gap. Here, `forceKill`
    // instead SCHEDULES the exit via a real (fake-timer-controlled)
    // `setTimeout`, simulating realistic exit-event latency, so this test
    // can observe whether shutdownAll's promise settles too early.
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    let sigtermIgnored = false;
    const processControl: ProcessControlFns = {
      exists: () => child.alive,
      kill: () => {
        sigtermIgnored = true; // SIGTERM ignored -> forces SIGKILL escalation
      },
      forceKill: () => {
        setTimeout(() => child.emitExit(null, 'SIGKILL'), 5);
      },
    };
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 10,
      onEvent: () => {},
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));

    let settled = false;
    const shutdownPromise = pool.shutdownAll().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10); // 1st grace period -> kill() (ignored)
    expect(sigtermIgnored).toBe(true);
    await vi.advanceTimersByTimeAsync(10); // 2nd grace period -> forceKill() called
    // forceKill has been CALLED, but its scheduled exit (+5ms) hasn't fired
    // yet -- the promise must NOT have settled at this point. This is
    // exactly the point the old code returned early.
    expect(settled).toBe(false);
    expect(pool.occupiedSlots).toBe(1);

    await vi.advanceTimersByTimeAsync(5); // the scheduled exit fires now
    await shutdownPromise;
    expect(settled).toBe(true);
    expect(pool.occupiedSlots).toBe(0);
  });

  it('shutdownAllSync best-effort force-kills every live session without waiting', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[1, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    pool.shutdownAllSync();
    expect(processControl.forceKillCalls).toEqual([1]);
  });
});

describe('ClaudeCliSessionPool: createConversation threads model + mcpServerEnv (LIA-454)', () => {
  it('threads model through to buildClaudeCliArgs as --model, appended to the spawn args', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn, calls } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', {
      ...createOptionsFor('a'),
      model: 'claude-sonnet-5',
    });
    expect(calls[0].args.slice(-2)).toEqual(['--model', 'claude-sonnet-5']);
  });

  it('omits --model when not supplied, unchanged from today', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn, calls } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    expect(calls[0].args).not.toContain('--model');
  });

  it('threads mcpServerEnv into the written --mcp-config JSON for the registered server', async () => {
    const child = new FakeChildProcess(1);
    const { spawnFn, calls } = createFakeSpawnFn([child]);
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn,
    });
    await pool.createConversation('conv-a', {
      ...createOptionsFor('a'),
      mcpServerEnv: {
        DEUS_NESTED_DISPATCH_CONTEXT: '{"permissionProfile":"default"}',
      },
    });
    const mcpConfigIndex = calls[0].args.indexOf('--mcp-config');
    const mcpConfigPath = calls[0].args[mcpConfigIndex + 1];
    const written = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    expect(written.mcpServers.deus_lia449.env).toEqual({
      DEUS_NESTED_DISPATCH_CONTEXT: '{"permissionProfile":"default"}',
    });
  });
});

describe('ClaudeCliSessionPool: terminate() (LIA-454)', () => {
  it('terminates a known conversation, mirroring shutdownAll for a single session', async () => {
    const child = new FakeChildProcess(7);
    const { spawnFn } = createFakeSpawnFn([child]);
    const childrenByPid = new Map([[7, child]]);
    const processControl = createFakeProcessControl(childrenByPid);
    const events: SessionLifecycleEvent[] = [];
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: (e) => events.push(e),
      spawnFn,
      processControl,
    });
    await pool.createConversation('conv-a', createOptionsFor('a'));
    expect(pool.occupiedSlots).toBe(1);

    await pool.terminate('conv-a');

    expect(pool.occupiedSlots).toBe(0);
    expect(pool.activeConversationIds).toEqual([]);
    expect(events.map((e) => e.type)).toContain('termination_requested');
  });

  it('is a no-op on an unknown conversation id (never throws)', async () => {
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 50,
      onEvent: () => {},
      spawnFn: createFakeSpawnFn([]).spawnFn,
    });
    await expect(pool.terminate('never-existed')).resolves.toBeUndefined();
  });
});

describe('ClaudeCliSessionError', () => {
  it('carries a stable code and optional detail', () => {
    const error = new ClaudeCliSessionError('boom', 'capacity_exceeded');
    expect(error.name).toBe('ClaudeCliSessionError');
    expect(error.code).toBe('capacity_exceeded');
    expect(error).toBeInstanceOf(Error);
  });
});
