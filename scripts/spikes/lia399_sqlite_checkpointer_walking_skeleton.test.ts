import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FakeToolCallingModel } from 'langchain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OLLAMA_BASE_URL,
  RESUME_PROMPT,
  START_PROMPT,
  closeCheckpointer,
  createCheckpointerAgent,
  locateCheckpoint,
  main,
  parseCliArgs,
  runTurn,
  serializeMessages,
  type MainDependencies,
  type MainReport,
} from './lia399_sqlite_checkpointer_walking_skeleton.js';

const SPIKE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'lia399_sqlite_checkpointer_walking_skeleton.ts',
);

// Fresh per-test temp directory; recursive removal in afterEach deletes the
// db plus its -wal/-shm siblings in one sweep.
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lia399-'));
  tempDirs.push(dir);
  return path.join(dir, 'checkpoints.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// FakeToolCallingModel is langchain's own createAgent test model (real
// BaseChatModel with a working bindTools), so the hermetic tests exercise
// the REAL SqliteSaver + createAgent checkpoint write/read path with only
// the network-bound LLM faked — CI's root vitest job has no Ollama daemon.
function fakeModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({ toolCalls: [] });
}

// The live suites are the plan's real-model proofs; they self-skip when no
// local Ollama daemon is reachable (CI) rather than failing the whole run.
async function ollamaReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const ollamaUp = await ollamaReachable();

describe('parseCliArgs', () => {
  it('parses the three flags in start mode', () => {
    expect(
      parseCliArgs(['--mode=start', '--db=/tmp/a.sqlite', '--thread=t-1']),
    ).toEqual({ mode: 'start', db: '/tmp/a.sqlite', thread: 't-1' });
  });

  it('parses resume mode regardless of flag order', () => {
    expect(
      parseCliArgs(['--thread=t-2', '--mode=resume', '--db=b.sqlite']),
    ).toEqual({ mode: 'resume', db: 'b.sqlite', thread: 't-2' });
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      parseCliArgs(['--mode=restart', '--db=a', '--thread=t']),
    ).toThrow('usage: --mode=start|resume --db=<path> --thread=<id>');
  });

  it('rejects a missing flag', () => {
    expect(() => parseCliArgs(['--mode=start', '--db=a'])).toThrow(
      'usage: --mode=start|resume --db=<path> --thread=<id>',
    );
  });

  it('rejects an unrecognized argument by name', () => {
    expect(() =>
      parseCliArgs(['--mode=start', '--db=a', '--thread=t', '--verbose']),
    ).toThrow('unrecognized argument: --verbose');
  });
});

describe('closeCheckpointer', () => {
  it('closes the underlying better-sqlite3 handle', () => {
    const checkpointer = SqliteSaver.fromConnString(tempDbPath());
    expect(checkpointer.db.open).toBe(true);

    closeCheckpointer(checkpointer);

    expect(checkpointer.db.open).toBe(false);
  });
});

describe('locateCheckpoint', () => {
  it('reports found false for a thread with no saved checkpoint', async () => {
    const checkpointer = SqliteSaver.fromConnString(tempDbPath());
    try {
      await expect(
        locateCheckpoint(checkpointer, 'never-used-thread'),
      ).resolves.toEqual({ found: false });
    } finally {
      closeCheckpointer(checkpointer);
    }
  });
});

describe('SQLite persistence round-trip (real saver + agent, fake model)', () => {
  it('resumes a thread in a fresh runtime instance with the first turn reloaded from SQLite', async () => {
    const dbPath = tempDbPath();
    const threadId = 'lia399-roundtrip';

    const first = createCheckpointerAgent(dbPath, fakeModel());
    let firstCount: number;
    try {
      const turn = await runTurn(first.agent, threadId, [
        { role: 'user', content: START_PROMPT },
      ]);
      if (!turn.succeeded) throw new Error(`first turn failed: ${turn.error}`);
      firstCount = turn.messages.length;
      expect(firstCount).toBeGreaterThanOrEqual(2);
    } finally {
      // Closed BEFORE the second instance opens: no shared JS references and
      // no shared db handle survive into the "fresh runtime".
      closeCheckpointer(first.checkpointer);
    }

    const second = createCheckpointerAgent(dbPath, fakeModel());
    try {
      const located = await locateCheckpoint(second.checkpointer, threadId);
      expect(located.found).toBe(true);
      expect(located.checkpointId).toBeTypeOf('string');
      expect(located.checkpointMessageCount).toBe(firstCount);

      const resumed = await runTurn(second.agent, threadId, [
        { role: 'user', content: RESUME_PROMPT },
      ]);
      if (!resumed.succeeded) {
        throw new Error(`resumed turn failed: ${resumed.error}`);
      }
      const texts = serializeMessages(resumed.messages);
      expect(
        texts.filter((m) => m.type === 'human').map((m) => m.text),
      ).toEqual([START_PROMPT, RESUME_PROMPT]);
      expect(resumed.messages.length).toBeGreaterThan(firstCount);
    } finally {
      closeCheckpointer(second.checkpointer);
    }
  });

  it('keeps threads isolated: a different thread_id on the same db sees none of the first thread', async () => {
    const dbPath = tempDbPath();

    const first = createCheckpointerAgent(dbPath, fakeModel());
    try {
      const turn = await runTurn(first.agent, 'thread-a', [
        { role: 'user', content: START_PROMPT },
      ]);
      expect(turn.succeeded).toBe(true);
    } finally {
      closeCheckpointer(first.checkpointer);
    }

    const second = createCheckpointerAgent(dbPath, fakeModel());
    try {
      await expect(
        locateCheckpoint(second.checkpointer, 'thread-b'),
      ).resolves.toEqual({ found: false });

      const other = await runTurn(second.agent, 'thread-b', [
        { role: 'user', content: 'Unrelated turn.' },
      ]);
      if (!other.succeeded) throw new Error(`turn failed: ${other.error}`);
      const humanTexts = serializeMessages(other.messages)
        .filter((m) => m.type === 'human')
        .map((m) => m.text);
      expect(humanTexts).toEqual(['Unrelated turn.']);
    } finally {
      closeCheckpointer(second.checkpointer);
    }
  });
});

describe('main', () => {
  function fakeDeps(overrides: Partial<MainDependencies> = {}): {
    deps: MainDependencies;
    closed: boolean[];
  } {
    const closed: boolean[] = [];
    const fakeCheckpointer = {} as ReturnType<
      MainDependencies['createCheckpointerAgent']
    >['checkpointer'];
    const deps: MainDependencies = {
      createCheckpointerAgent: vi.fn(() => ({
        agent: {} as never,
        checkpointer: fakeCheckpointer,
      })) as unknown as MainDependencies['createCheckpointerAgent'],
      locateCheckpoint: vi.fn(async () => ({
        found: true,
        checkpointId: 'ckpt-1',
        checkpointMessageCount: 2,
      })) as unknown as MainDependencies['locateCheckpoint'],
      runTurn: vi.fn(async () => ({
        succeeded: true as const,
        messages: [],
      })) as unknown as MainDependencies['runTurn'],
      closeCheckpointer: vi.fn(() => {
        closed.push(true);
      }) as unknown as MainDependencies['closeCheckpointer'],
      ...overrides,
    };
    return { deps, closed };
  }

  function lastReport(log: ReturnType<typeof vi.spyOn>): MainReport {
    const lastCall = log.mock.calls.at(-1);
    if (lastCall === undefined) throw new Error('console.log never called');
    return JSON.parse(lastCall[0] as string) as MainReport;
  }

  it('prints a single JSON line with the pre-turn checkpoint location and turn outcome', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { deps, closed } = fakeDeps();

      await main(['--mode=resume', '--db=/tmp/x.sqlite', '--thread=t-9'], deps);

      expect(log).toHaveBeenCalledTimes(1);
      const report = lastReport(log);
      expect(report.mode).toBe('resume');
      expect(report.threadId).toBe('t-9');
      expect(report.dbPath).toBe('/tmp/x.sqlite');
      expect(report.checkpointBeforeTurn).toEqual({
        found: true,
        checkpointId: 'ckpt-1',
        checkpointMessageCount: 2,
      });
      expect(report.turn).toEqual({ succeeded: true });
      expect(report.messageCount).toBe(0);
      expect(closed).toEqual([true]);
      expect(vi.mocked(deps.runTurn).mock.calls[0]?.[2]).toEqual([
        { role: 'user', content: RESUME_PROMPT },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('sends the start prompt in start mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { deps } = fakeDeps();

      await main(['--mode=start', '--db=/tmp/x.sqlite', '--thread=t-9'], deps);

      expect(vi.mocked(deps.runTurn).mock.calls[0]?.[2]).toEqual([
        { role: 'user', content: START_PROMPT },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('reports a failed turn without messages and still closes the checkpointer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { deps, closed } = fakeDeps({
        runTurn: vi.fn(async () => ({
          succeeded: false as const,
          error: 'model unreachable',
        })) as unknown as MainDependencies['runTurn'],
      });

      await main(['--mode=start', '--db=/tmp/x.sqlite', '--thread=t'], deps);

      const report = lastReport(log);
      expect(report.turn).toEqual({
        succeeded: false,
        error: 'model unreachable',
      });
      expect(report.messages).toBeUndefined();
      expect(closed).toEqual([true]);
    } finally {
      log.mockRestore();
    }
  });

  it('closes the checkpointer even when locateCheckpoint throws', async () => {
    const { deps, closed } = fakeDeps({
      locateCheckpoint: vi.fn(async () => {
        throw new Error('disk gone');
      }) as unknown as MainDependencies['locateCheckpoint'],
    });

    await expect(
      main(['--mode=start', '--db=/tmp/x.sqlite', '--thread=t'], deps),
    ).rejects.toThrow('disk gone');

    expect(closed).toEqual([true]);
    expect(deps.runTurn).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ollamaUp)(
  'live resume against local Ollama (skipped when no daemon is reachable)',
  () => {
    it(
      'resumes a real-model thread in a fresh same-process runtime instance',
      { timeout: 180_000 },
      async () => {
        const dbPath = tempDbPath();
        const threadId = 'lia399-live';

        const first = createCheckpointerAgent(dbPath);
        let firstCount: number;
        try {
          const turn = await runTurn(first.agent, threadId, [
            { role: 'user', content: START_PROMPT },
          ]);
          if (!turn.succeeded) {
            throw new Error(`first live turn failed: ${turn.error}`);
          }
          firstCount = turn.messages.length;
        } finally {
          closeCheckpointer(first.checkpointer);
        }

        const second = createCheckpointerAgent(dbPath);
        try {
          const located = await locateCheckpoint(second.checkpointer, threadId);
          expect(located.found).toBe(true);

          const resumed = await runTurn(second.agent, threadId, [
            { role: 'user', content: RESUME_PROMPT },
          ]);
          if (!resumed.succeeded) {
            throw new Error(`resumed live turn failed: ${resumed.error}`);
          }
          const humanTexts = serializeMessages(resumed.messages)
            .filter((m) => m.type === 'human')
            .map((m) => m.text);
          expect(humanTexts).toEqual([START_PROMPT, RESUME_PROMPT]);
          expect(resumed.messages.length).toBeGreaterThan(firstCount);
        } finally {
          closeCheckpointer(second.checkpointer);
        }
      },
    );

    interface ChildRun {
      code: number | null;
      report: MainReport;
      stderr: string;
    }

    function runSpikeChild(args: string[]): Promise<ChildRun> {
      const tsxPath = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
      // Throwaway spike scope is intentionally POSIX-only; production portability remains centralized in src/platform.ts.
      const child = spawn(tsxPath, [SPIKE_PATH, ...args]);
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
          // The report is the last stdout line that parses as JSON — tolerant
          // of any incidental library logging above it.
          const jsonLine = stdout
            .split('\n')
            .filter((line) => line.trim().startsWith('{'))
            .at(-1);
          if (jsonLine === undefined) {
            reject(
              new Error(
                `spike child printed no JSON line (code=${String(code)}, stderr=${stderr})`,
              ),
            );
            return;
          }
          resolve({
            code,
            report: JSON.parse(jsonLine) as MainReport,
            stderr,
          });
        });
      });
    }

    it(
      'a second OS process resumes the thread a first OS process persisted',
      { timeout: 360_000 },
      async () => {
        const dbPath = tempDbPath();
        const threadId = 'lia399-two-process';
        const flags = [`--db=${dbPath}`, `--thread=${threadId}`];

        const start = await runSpikeChild(['--mode=start', ...flags]);
        expect(start.code).toBe(0);
        expect(start.report.mode).toBe('start');
        expect(start.report.checkpointBeforeTurn).toEqual({ found: false });
        expect(start.report.turn.succeeded).toBe(true);
        const startCount = start.report.messageCount;
        if (startCount === undefined) {
          throw new Error('start child reported no messageCount');
        }

        const resume = await runSpikeChild(['--mode=resume', ...flags]);
        expect(resume.code).toBe(0);
        expect(resume.report.mode).toBe('resume');
        // The session identifier alone located the first process's saved
        // checkpoint, before the resumed turn ran.
        expect(resume.report.checkpointBeforeTurn.found).toBe(true);
        expect(resume.report.checkpointBeforeTurn.checkpointId).toBeTypeOf(
          'string',
        );
        expect(resume.report.checkpointBeforeTurn.checkpointMessageCount).toBe(
          startCount,
        );
        expect(resume.report.turn.succeeded).toBe(true);

        const humanTexts = (resume.report.messages ?? [])
          .filter((m) => m.type === 'human')
          .map((m) => m.text);
        expect(humanTexts).toEqual([START_PROMPT, RESUME_PROMPT]);
        expect(resume.report.messageCount ?? 0).toBeGreaterThan(startCount);
      },
    );
  },
);
