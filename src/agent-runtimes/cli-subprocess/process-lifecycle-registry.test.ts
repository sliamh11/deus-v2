/**
 * LIA-454 EP-002 step 9: tests for the cross-process lease primitives —
 * `acquireThreadTurnLease` (thread_id-keyed exclusive turn lease) and
 * `acquireProcessSlot` (production-wide CLI process cap). Real fs against
 * a real tmpdir (matching `auth-refresh.test.ts`'s own precedent — file
 * lock semantics like EEXIST are finicky to mock faithfully); process
 * identity, clock, nonce, and sleep are injected so staleness/contention
 * scenarios are deterministic and don't touch real processes or real time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// LIA-459: matches auth-refresh.test.ts's own established mocking
// convention for this module — a plain vi.fn() surface, no real log output.
const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}));

import {
  acquireProcessSlot,
  acquireThreadTurnLease,
  ProcessLifecycleRegistryError,
  type RegistryDeps,
} from './process-lifecycle-registry.js';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia454-process-lifecycle-'),
  );
  loggerWarnMock.mockClear();
});
afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

function fakeDeps(
  overrides: Partial<RegistryDeps> = {},
): Partial<RegistryDeps> {
  let nonceCounter = 0;
  let clock = 1_000_000;
  return {
    processExists: () => true,
    getProcessStartIdentity: () => ({
      status: 'found',
      value: 'fixed-start-time',
    }),
    getProcessCommandLine: () => ({
      status: 'found',
      value: 'fixed-command-line',
    }),
    now: () => clock++,
    randomNonce: () => `nonce-${nonceCounter++}`,
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

function threadHashOf(threadId: string): string {
  return crypto.createHash('sha256').update(threadId, 'utf8').digest('hex');
}

describe('acquireThreadTurnLease', () => {
  it('acquires a fresh lease and writes a lease file keyed by sha256(threadId), never the raw id', async () => {
    const lease = await acquireThreadTurnLease('thread-abc', {
      rootDir: scratchRoot,
      deps: fakeDeps(),
    });
    expect(lease).not.toBeNull();
    expect(lease!.threadHash).toBe(threadHashOf('thread-abc'));
    expect(lease!.path).toContain(threadHashOf('thread-abc'));
    expect(fs.existsSync(lease!.path)).toBe(true);
    const raw = fs.readFileSync(lease!.path, 'utf8');
    expect(raw).not.toContain('thread-abc');
  });

  it('rejects an empty threadId', async () => {
    await expect(
      acquireThreadTurnLease('', { rootDir: scratchRoot, deps: fakeDeps() }),
    ).rejects.toThrow(ProcessLifecycleRegistryError);
  });

  it('returns null when a live owner already holds the lease (never reclaims a live lease)', async () => {
    const first = await acquireThreadTurnLease('thread-live', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => true }),
    });
    expect(first).not.toBeNull();

    const second = await acquireThreadTurnLease('thread-live', {
      rootDir: scratchRoot,
      maxAttempts: 2,
      deps: fakeDeps({ processExists: () => true }),
    });
    expect(second).toBeNull();
  });

  it('reclaims the lease when the recorded owner PID is dead', async () => {
    const first = await acquireThreadTurnLease('thread-dead-owner', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    expect(first).not.toBeNull();

    // A second acquire (different "process") sees the same on-disk lease
    // but with a deps set reporting the recorded owner PID as dead.
    const second = await acquireThreadTurnLease('thread-dead-owner', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);
  });

  it('reclaims the lease when the owner PID is alive but its start-identity no longer matches (PID reuse)', async () => {
    const first = await acquireThreadTurnLease('thread-pid-reuse', {
      rootDir: scratchRoot,
      deps: fakeDeps({
        processExists: () => true,
        getProcessStartIdentity: () => ({
          status: 'found',
          value: 'original-start-time',
        }),
      }),
    });
    expect(first).not.toBeNull();

    const second = await acquireThreadTurnLease('thread-pid-reuse', {
      rootDir: scratchRoot,
      deps: fakeDeps({
        processExists: () => true,
        getProcessStartIdentity: () => ({
          status: 'found',
          value: 'DIFFERENT-start-time',
        }),
      }),
    });
    expect(second).not.toBeNull();
  });

  it('reclaims when start-identity matches but the command line does not (corroborating PID-reuse signal)', async () => {
    const first = await acquireThreadTurnLease('thread-cmdline-reuse', {
      rootDir: scratchRoot,
      deps: fakeDeps({
        processExists: () => true,
        getProcessCommandLine: () => ({
          status: 'found',
          value: 'original-cmd',
        }),
      }),
    });
    expect(first).not.toBeNull();

    const second = await acquireThreadTurnLease('thread-cmdline-reuse', {
      rootDir: scratchRoot,
      deps: fakeDeps({
        processExists: () => true,
        getProcessCommandLine: () => ({
          status: 'found',
          value: 'DIFFERENT-cmd',
        }),
      }),
    });
    expect(second).not.toBeNull();
  });

  it('a lost eviction race (rename throws ENOENT, simulating another evictor winning first) returns null cleanly, leaves no orphaned quarantine file, and a later attempt still succeeds', async () => {
    const first = await acquireThreadTurnLease('thread-lost-race', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }), // dead owner -> eligible for eviction
    });
    expect(first).not.toBeNull();

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const lostRace = await acquireThreadTurnLease('thread-lost-race', {
      rootDir: scratchRoot,
      maxAttempts: 1,
      deps: fakeDeps({ processExists: () => false }),
    });
    renameSpy.mockRestore();
    expect(lostRace).toBeNull();

    // No orphaned quarantine file — only the original lease file remains.
    const filesInDir = fs.readdirSync(path.dirname(first!.path));
    expect(filesInDir).toEqual([path.basename(first!.path)]);

    // A subsequent real attempt (mock removed) must still succeed normally.
    const recovered = await acquireThreadTurnLease('thread-lost-race', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    expect(recovered).not.toBeNull();
  });

  it('restores a captured lease that turns out to be live after all (owner came back between the staleness read and eviction), rather than destroying it', async () => {
    const first = await acquireThreadTurnLease('thread-restore-live', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }), // looks dead at first read
    });
    expect(first).not.toBeNull();
    const beforeContent = fs.readFileSync(first!.path, 'utf8');

    let callCount = 0;
    // 1st call = attemptExclusiveLease's initial staleness read (says dead,
    // triggers eviction). 2nd call = evictViaRename's re-check of what it
    // actually captured (says alive after all -> must restore, not destroy).
    const flakyProcessExists = () => {
      callCount++;
      return callCount >= 2;
    };

    const second = await acquireThreadTurnLease('thread-restore-live', {
      rootDir: scratchRoot,
      maxAttempts: 1,
      deps: fakeDeps({ processExists: flakyProcessExists }),
    });
    expect(second).toBeNull();

    // No orphaned quarantine file, and the original content is restored
    // byte-for-byte — never silently dropped or corrupted.
    const filesInDir = fs.readdirSync(path.dirname(first!.path));
    expect(filesInDir).toEqual([path.basename(first!.path)]);
    expect(fs.readFileSync(first!.path, 'utf8')).toBe(beforeContent);

    // The original owner's release() must still work after the restore.
    first!.release();
    expect(fs.existsSync(first!.path)).toBe(false);
  });

  it('documents the residual restore-window gap: a fresh acquirer landing in the emptied slot during a restore is never clobbered (though the captured live lease is then orphaned, not restored)', async () => {
    const first = await acquireThreadTurnLease('thread-restore-vs-thirdparty', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    expect(first).not.toBeNull();

    let processExistsCallCount = 0;
    const flakyProcessExists = () => {
      processExistsCallCount++;
      return processExistsCallCount >= 2; // dead on the 1st check, alive on re-validation -> restore path
    };

    const originalLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi
      .spyOn(fs, 'linkSync')
      .mockImplementationOnce((...args: Parameters<typeof fs.linkSync>) => {
        // Simulate a fresh acquirer's wx-create racing into the now-empty
        // lockPath in the exact window between the eviction rename and
        // this restore attempt.
        fs.writeFileSync(
          first!.path,
          JSON.stringify({
            kind: 'thread-turn',
            ownerPid: 424242,
            ownerStartIdentity: 'third-party',
            ownerCommandLine: 'third-party-cmd',
            nonce: 'third-party-nonce',
            acquiredAtMs: 0,
          }),
          { flag: 'wx' },
        );
        // The REAL linkSync now genuinely fails EEXIST, same as production.
        return originalLinkSync(...args);
      });

    const second = await acquireThreadTurnLease(
      'thread-restore-vs-thirdparty',
      {
        rootDir: scratchRoot,
        maxAttempts: 1,
        deps: fakeDeps({ processExists: flakyProcessExists }),
      },
    );
    linkSpy.mockRestore();
    expect(second).toBeNull(); // this acquire attempt itself did not win

    // The third party's fresh lease is intact and untouched — never clobbered.
    const finalContent = JSON.parse(fs.readFileSync(first!.path, 'utf8')) as {
      nonce: string;
    };
    expect(finalContent.nonce).toBe('third-party-nonce');

    // No orphaned quarantine file. Note what this also proves: the
    // ORIGINAL captured lease is gone (its nonce is nowhere on disk) —
    // the documented residual gap, not a corrupted/leaked intermediate state.
    const filesInDir = fs.readdirSync(path.dirname(first!.path));
    expect(filesInDir).toEqual([path.basename(first!.path)]);
  });

  it('LIA-459: logs a warning when the residual restore-window race orphans a captured live lease (observability mitigation)', async () => {
    // Exact same fixture as the residual-gap test above — a fresh
    // acquirer's wx-create races into the emptied lockPath during the
    // eviction-restore window, so the captured live lease is discarded
    // rather than restored. This test asserts ONLY the new, additive log
    // line fires with the right field — behavior/return-value assertions
    // for this fixture are already covered by the sibling test above.
    const first = await acquireThreadTurnLease('thread-orphan-logs', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    expect(first).not.toBeNull();

    let processExistsCallCount = 0;
    const flakyProcessExists = () => {
      processExistsCallCount++;
      return processExistsCallCount >= 2;
    };

    const originalLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi
      .spyOn(fs, 'linkSync')
      .mockImplementationOnce((...args: Parameters<typeof fs.linkSync>) => {
        fs.writeFileSync(
          first!.path,
          JSON.stringify({
            kind: 'thread-turn',
            ownerPid: 424242,
            ownerStartIdentity: 'third-party',
            ownerCommandLine: 'third-party-cmd',
            nonce: 'third-party-nonce',
            acquiredAtMs: 0,
          }),
          { flag: 'wx' },
        );
        return originalLinkSync(...args);
      });

    expect(loggerWarnMock).not.toHaveBeenCalled();
    await acquireThreadTurnLease('thread-orphan-logs', {
      rootDir: scratchRoot,
      maxAttempts: 1,
      deps: fakeDeps({ processExists: flakyProcessExists }),
    });
    linkSpy.mockRestore();

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerWarnMock.mock.calls[0] as [
      { threadHash?: string },
      string,
    ];
    expect(fields.threadHash).toBe(threadHashOf('thread-orphan-logs'));
    expect(message).toContain('orphaned a live lease');
  });

  it('does NOT reclaim on unverifiable identity until the mtime-age floor is exceeded', async () => {
    // The mtime-fallback compares the injected clock against a REAL
    // filesystem mtime, so this scenario needs the real wall clock rather
    // than the other tests' fake incrementing counter.
    const unverifiableDeps = () =>
      fakeDeps({
        getProcessStartIdentity: () => ({ status: 'unverifiable' }),
        now: () => Date.now(),
      });

    const first = await acquireThreadTurnLease('thread-unverifiable', {
      rootDir: scratchRoot,
      deps: unverifiableDeps(),
    });
    expect(first).not.toBeNull();

    // Fresh mtime, small stale threshold not yet exceeded -> must NOT reclaim.
    const stillFresh = await acquireThreadTurnLease('thread-unverifiable', {
      rootDir: scratchRoot,
      maxAttempts: 1,
      staleLeaseMs: 10 * 60 * 1000,
      deps: unverifiableDeps(),
    });
    expect(stillFresh).toBeNull();

    // Backdate the lease file's mtime past a tiny staleLeaseMs floor -> must reclaim.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(first!.path, past, past);
    const reclaimed = await acquireThreadTurnLease('thread-unverifiable', {
      rootDir: scratchRoot,
      staleLeaseMs: 1,
      deps: unverifiableDeps(),
    });
    expect(reclaimed).not.toBeNull();
  });

  it('release() removes the lease file when still owned (nonce match)', async () => {
    const lease = await acquireThreadTurnLease('thread-release', {
      rootDir: scratchRoot,
      deps: fakeDeps(),
    });
    expect(fs.existsSync(lease!.path)).toBe(true);
    lease!.release();
    expect(fs.existsSync(lease!.path)).toBe(false);
  });

  it('release() does NOT remove a lease file that a different owner has since reclaimed (nonce mismatch)', async () => {
    const lease = await acquireThreadTurnLease('thread-stolen', {
      rootDir: scratchRoot,
      deps: fakeDeps({ processExists: () => false }),
    });
    // Simulate another process reclaiming the same (now-stale-looking) lease
    // before this one calls release().
    fs.writeFileSync(
      lease!.path,
      JSON.stringify({
        kind: 'thread-turn',
        ownerPid: 999,
        ownerStartIdentity: 'someone-elses-identity',
        nonce: 'someone-elses-nonce',
        acquiredAtMs: Date.now(),
        threadHash: lease!.threadHash,
      }),
    );
    lease!.release();
    expect(fs.existsSync(lease!.path)).toBe(true);
  });

  it('gives up and returns null after maxAttempts when the lease stays genuinely live', async () => {
    const deps = fakeDeps({ processExists: () => true });
    const sleepSpy = vi.fn(async () => {});
    await acquireThreadTurnLease('thread-contended', {
      rootDir: scratchRoot,
      deps,
    });
    const result = await acquireThreadTurnLease('thread-contended', {
      rootDir: scratchRoot,
      maxAttempts: 3,
      deps: { ...deps, sleep: sleepSpy },
    });
    expect(result).toBeNull();
    expect(sleepSpy).toHaveBeenCalledTimes(2); // maxAttempts - 1
  });
});

describe('acquireThreadTurnLease — real concurrent contention (LIA-459 gap)', () => {
  // These three tests exercise the ACTUAL cross-process contention path this
  // module claims to protect: genuinely concurrent async callers (Promise.all,
  // no await between them) racing for the SAME on-disk lease file, using real
  // fs, real process-identity checks, and real jittered retry timers — never
  // the sequential fake-clock simulation the other 18 tests in this file use.
  // LIA-459 wires this already-shipped primitive onto the raw-HTTP transport;
  // this closes the primitive's own missing real-concurrency oracle that the
  // ticket calls out ("Test real cross-process contention"). Authored by
  // oracle-author from the spec, blind to any implementation (this function
  // is pre-existing, unmodified code — these close a coverage gap, not a
  // red-before-green implementation gap), then mutation-verified: reverting
  // the atomic wx-create to a plain w-create made all three tests fail, along
  // with 7 of the 18 pre-existing tests.

  it('exactly one of N genuinely concurrent callers for the same threadId wins the lease', async () => {
    // @oracle: LIA-459 — real Promise.all race must yield exactly 1 winner, never 0 or >1
    const threadId = 'thread-real-race';
    const N = 5;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        acquireThreadTurnLease(threadId, {
          rootDir: scratchRoot,
          maxAttempts: 5,
        }),
      ),
    );

    const winners = results.filter(
      (r): r is NonNullable<(typeof results)[number]> => r !== null,
    );
    expect(winners).toHaveLength(1);
    expect(winners[0].threadHash).toBe(threadHashOf(threadId));
  });

  it('a caller still in-flight in its jittered retry loop succeeds once the live owner releases mid-race, not merely after a fully sequential hand-off', async () => {
    // @oracle: LIA-459 — B must be genuinely racing (already called, not yet
    // consumed) when A releases; a sequential "await A, release, then call B"
    // rewrite would not exercise the real retry-loop interleaving this guards.
    const threadId = 'thread-live-retry-race';

    const aPromise = acquireThreadTurnLease(threadId, {
      rootDir: scratchRoot,
    });
    // B is issued before A is awaited/consumed — both calls are genuinely in
    // flight together, matching how two real concurrent turns would hit this.
    const bPromise = acquireThreadTurnLease(threadId, {
      rootDir: scratchRoot,
      maxAttempts: 10,
    });

    const winnerA = await aPromise;
    expect(winnerA).not.toBeNull();
    const aNonce = (
      JSON.parse(fs.readFileSync(winnerA!.path, 'utf8')) as { nonce: string }
    ).nonce;

    // B is still asleep in its real jittered backoff right now (its first
    // attempt already lost to A synchronously; its next real timer has not
    // yet fired) — releasing here is strictly INSIDE that in-flight window,
    // never after B has already exhausted its attempts and given up.
    winnerA!.release();

    const winnerB = await bPromise;
    expect(winnerB).not.toBeNull();
    expect(winnerB!.threadHash).toBe(winnerA!.threadHash);

    const bNonce = (
      JSON.parse(fs.readFileSync(winnerB!.path, 'utf8')) as { nonce: string }
    ).nonce;
    expect(bNonce).not.toBe(aNonce); // a genuinely new acquisition, not stale reuse
  });

  it('losers of a real concurrent race never leave a lingering lease file on disk — exactly one file exists for the winner', async () => {
    // @oracle: LIA-459 — a write-then-detect-conflict implementation (as
    // opposed to atomic create-or-fail) could leave loser debris (a stray
    // candidate/temp file, or a clobbered-then-orphaned file) even while
    // still reporting "exactly one winner"; this checks disk state directly.
    const threadId = 'thread-no-debris';
    const N = 5;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        acquireThreadTurnLease(threadId, {
          rootDir: scratchRoot,
          maxAttempts: 1,
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);

    const threadTurnsDirPath = path.join(
      scratchRoot,
      'cli-subprocess',
      'thread-turns',
    );
    const filesOnDisk = fs.existsSync(threadTurnsDirPath)
      ? fs.readdirSync(threadTurnsDirPath)
      : [];
    expect(filesOnDisk).toEqual([`${threadHashOf(threadId)}.lease.json`]);
  });
});

describe('acquireProcessSlot', () => {
  it('acquires a free slot out of the pool', async () => {
    const slot = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 4,
      deps: fakeDeps(),
    });
    expect(slot).not.toBeNull();
    expect(slot!.slotIndex).toBeGreaterThanOrEqual(0);
    expect(slot!.slotIndex).toBeLessThan(4);
    expect(fs.existsSync(slot!.path)).toBe(true);
  });

  it('fills all slots then returns null once the pool is exhausted (live owners)', async () => {
    const deps = fakeDeps({ processExists: () => true });
    const held = [];
    for (let i = 0; i < 3; i++) {
      const slot = await acquireProcessSlot({
        rootDir: scratchRoot,
        slotCount: 3,
        deps,
      });
      expect(slot).not.toBeNull();
      held.push(slot);
    }
    const distinctSlots = new Set(held.map((s) => s!.slotIndex));
    expect(distinctSlots.size).toBe(3);

    const overflow = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 3,
      maxAttempts: 2,
      deps,
    });
    expect(overflow).toBeNull();
  });

  it('reclaims a stale slot (dead owner) even when other slots are live', async () => {
    const first = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 2,
      deps: fakeDeps({ processExists: () => true }),
    });
    expect(first).not.toBeNull();
    const record = JSON.parse(fs.readFileSync(first!.path, 'utf8')) as {
      ownerPid: number;
    };
    const deadPid = record.ownerPid;

    const second = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 2,
      deps: fakeDeps({ processExists: (pid) => pid !== deadPid }),
    });
    expect(second).not.toBeNull();
  });

  it('rejects slotCount < 1', async () => {
    await expect(
      acquireProcessSlot({
        rootDir: scratchRoot,
        slotCount: 0,
        deps: fakeDeps(),
      }),
    ).rejects.toThrow(ProcessLifecycleRegistryError);
  });

  it('release() frees the slot for a subsequent acquire', async () => {
    const deps = fakeDeps({ processExists: () => true });
    const slot = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 1,
      deps,
    });
    expect(slot).not.toBeNull();
    slot!.release();
    const reacquired = await acquireProcessSlot({
      rootDir: scratchRoot,
      slotCount: 1,
      deps,
    });
    expect(reacquired).not.toBeNull();
  });
});
