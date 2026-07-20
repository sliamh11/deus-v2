/**
 * Cross-process lifecycle registry for the CLI-subprocess transport
 * (LIA-454 EP-002 step 9, ADR §3.5 "process lifecycle / orphan control").
 *
 * Two independent lease classes share one atomic-file-lease primitive:
 *
 *  - `thread-turns/`: an exclusive, `sha256(thread_id)`-keyed lease held for
 *    the duration of a single turn (parent or nested-dispatch). Closes a
 *    real lost-update race across processes that SQLite's own
 *    statement-level serialization does NOT close — a compare-before-`put`
 *    re-read is TOCTOU-racy across separate `claude` subprocesses (or
 *    separate Deus process instances) hitting the same `thread_id`
 *    concurrently.
 *  - `process-slots/`: a small, fixed pool of production-wide slots
 *    bounding the total number of concurrently spawned `claude` CLI
 *    subprocesses across ALL Deus process instances on this host. The
 *    in-process `maxProcesses` cap in `ClaudeCliSessionPool` only bounds a
 *    single Deus process, not the whole host — this is the missing
 *    cross-process floor ADR §3.5 calls out.
 *
 * Both lease classes use the same primitive: atomic `O_CREAT|O_EXCL`
 * (`"wx"`) file creation for a genuinely free slot (same technique as
 * `auth-refresh.ts`'s existing lock), a JSON body recording the owner's
 * PID + two independent POSIX identity fingerprints (`platform.ts`'s
 * `getProcessStartIdentity`/`getProcessCommandLine`) + a random nonce, and
 * stale-owner reconciliation before granting or reclaiming a lease:
 *
 *   1. Owner PID is dead (`processExists` false) → definitely stale, reclaim.
 *   2. Owner PID is alive but its current start-identity, or (as a second,
 *      independent corroborating signal) its command line, no longer
 *      matches the recorded fingerprint → PID reuse by an unrelated
 *      process, definitely stale, reclaim.
 *   3. Owner PID is alive and both fingerprints match (or corroborating
 *      ones are unavailable) → definitely live, never reclaim.
 *   4. Start-identity can't be compared at all right now — either the
 *      live query failed/is `unverifiable`, or the RECORDED identity
 *      itself was `null` (unverifiable at acquire time) — cannot prove
 *      staleness by identity, fall back to the same bounded mtime-age
 *      heuristic `auth-refresh.ts` already uses in this repo, rather than
 *      either trusting an unverifiable owner forever or reclaiming
 *      blindly. `unverifiable` is dead code in production today since the
 *      whole CLI-subprocess transport is POSIX-only per the LIA-449 ADR's
 *      "Platform scope", kept here only as a defensive floor.
 *
 * Reclaiming a stale lease via a plain `unlink`+`create` would be a real
 * TOCTOU: two racing evictors could both decide the SAME stale record is
 * safe to remove, both succeed, and both believe they now hold an
 * exclusive lease. Eviction is instead done via `rename(lockPath,
 * quarantine)`: POSIX guarantees only ONE concurrent `rename` of a given
 * source path can succeed (the others get `ENOENT`, since the source is
 * already gone) — so at most one process ever wins the right to evict a
 * given lease generation. The winner then re-reads what it actually
 * captured (never trusting its earlier, possibly-stale read) and, if that
 * capture turns out to be a live lease after all (lost a race against the
 * true owner refreshing/recreating it), restores it via the same
 * exclusive-style `link` primitive rather than clobbering it. Release
 * uses the identical rename-then-verify sequence, so a lease can never be
 * deleted out from under an owner that has since (re)claimed it.
 *
 * Fail-closed posture throughout: ambiguity never reclaims — it retries
 * with jitter instead, up to a bounded attempt count.
 *
 * KNOWN RESIDUAL GAP (LIA-454 EP-002 step 9 code review, round 2 — SHIP
 * with this documented, not a blocker for this still-caller-less module):
 * the rename-based eviction closes the DOUBLE-GRANT race, but restoring a
 * captured lease that turns out to be live has its own narrow window —
 * `lockPath` is genuinely empty between the eviction `rename` and the
 * restore `link`, so a fresh acquirer's `wx`-create can legitimately land
 * there first; the restore then correctly fails without clobbering that
 * fresh acquirer, but the captured (live, mid-turn) lease is discarded
 * rather than restored, orphaning its owner. This requires the underlying
 * staleness signal to flip within a single attempt (a transient `ps`
 * hiccup, not a real owner mutation — this module never mutates a lease
 * in place), so it is expected to be extremely rare in practice, but it is
 * real. Must be closed (e.g. real OS advisory locking via `flock`/`fcntl`)
 * or explicitly re-risk-accepted before step 10/11 wires a production
 * caller — see EP-002's decision log.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../../logger.js';
import { STORE_DIR } from '../../config.js';
import {
  getProcessCommandLine as defaultGetProcessCommandLine,
  getProcessStartIdentity as defaultGetProcessStartIdentity,
  processExists as defaultProcessExists,
  type ProcessIdentityResult,
} from '../../platform.js';

export class ProcessLifecycleRegistryError extends Error {}

const DEFAULT_STALE_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_MIN_RETRY_JITTER_MS = 25;
const DEFAULT_MAX_RETRY_JITTER_MS = 150;
const DEFAULT_PROCESS_SLOT_COUNT = 8;

export interface RegistryDeps {
  processExists: (pid: number) => boolean;
  getProcessStartIdentity: (pid: number) => ProcessIdentityResult;
  getProcessCommandLine: (pid: number) => ProcessIdentityResult;
  now: () => number;
  randomNonce: () => string;
  sleep: (ms: number) => Promise<void>;
}

function defaultDeps(): RegistryDeps {
  return {
    processExists: defaultProcessExists,
    getProcessStartIdentity: defaultGetProcessStartIdentity,
    getProcessCommandLine: defaultGetProcessCommandLine,
    now: () => Date.now(),
    randomNonce: () => crypto.randomBytes(16).toString('hex'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

interface LeaseRecord {
  kind: 'thread-turn' | 'process-slot';
  ownerPid: number;
  /** null means the owner's start-identity was unverifiable when it acquired the lease. */
  ownerStartIdentity: string | null;
  /** null means the owner's command line was unverifiable when it acquired the lease. */
  ownerCommandLine: string | null;
  nonce: string;
  acquiredAtMs: number;
  threadHash?: string;
}

interface AcquireCommonOptions {
  deps?: Partial<RegistryDeps>;
  rootDir?: string;
  maxAttempts?: number;
  staleLeaseMs?: number;
  minRetryJitterMs?: number;
  maxRetryJitterMs?: number;
}

export type AcquireLeaseOptions = AcquireCommonOptions;

export interface AcquireProcessSlotOptions extends AcquireCommonOptions {
  slotCount?: number;
}

export interface ThreadTurnLease {
  readonly threadHash: string;
  readonly path: string;
  release(): void;
}

export interface ProcessSlotLease {
  readonly slotIndex: number;
  readonly path: string;
  release(): void;
}

function registryRootDir(rootDir: string): string {
  return path.join(rootDir, 'cli-subprocess');
}

function threadTurnsDir(rootDir: string): string {
  return path.join(registryRootDir(rootDir), 'thread-turns');
}

function processSlotsDir(rootDir: string): string {
  return path.join(registryRootDir(rootDir), 'process-slots');
}

function jitterDelayMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function readLeaseRecord(lockPath: string): LeaseRecord | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as LeaseRecord).ownerPid !== 'number' ||
      typeof (parsed as LeaseRecord).nonce !== 'string'
    ) {
      return null;
    }
    return parsed as LeaseRecord;
  } catch {
    return null;
  }
}

function isLeaseStale(
  record: LeaseRecord,
  statPath: string,
  deps: RegistryDeps,
  staleLeaseMs: number,
): boolean {
  if (!deps.processExists(record.ownerPid)) return true;

  const identity = deps.getProcessStartIdentity(record.ownerPid);
  if (identity.status === 'found' && record.ownerStartIdentity !== null) {
    if (identity.value !== record.ownerStartIdentity) return true; // PID reuse

    // Start-identity matches — corroborate with the command line as a
    // second, independent PID-reuse signal. This only ever tightens the
    // verdict toward "stale"; a command-line query that's unavailable
    // right now never downgrades an otherwise-confirmed-live verdict.
    const cmd = deps.getProcessCommandLine(record.ownerPid);
    if (cmd.status === 'found' && record.ownerCommandLine !== null) {
      return cmd.value !== record.ownerCommandLine;
    }
    return false; // confirmed live by start-identity
  }

  // Identity can't be compared at all right now — either the live query
  // failed/`unverifiable`, or the RECORDED identity was itself `null`
  // (unverifiable at acquire time). Fall back to the bounded mtime-age
  // floor rather than trusting an unverifiable owner forever.
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(statPath).mtimeMs;
  } catch {
    return true; // lease file vanished mid-check — safe to treat as gone
  }
  return deps.now() - mtimeMs > staleLeaseMs;
}

function tryCreateLeaseFile(lockPath: string, record: LeaseRecord): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(record));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * Attempt to evict whatever is CURRENTLY at `lockPath` via an atomic
 * `rename` into a private quarantine path. POSIX guarantees at most one
 * concurrent `rename` of the same source path can succeed — any other
 * evictor racing on the same stale record gets `ENOENT` and backs off,
 * closing the double-grant TOCTOU a plain `unlink`+`create` would have.
 * The caller must not assume the captured content is what it read
 * earlier — `restoreIfLive` re-validates it and puts it back if so.
 */
function evictViaRename(
  lockPath: string,
  deps: RegistryDeps,
  staleLeaseMs: number,
): 'evicted' | 'lost-race' {
  const quarantinePath = `${lockPath}.evict-${deps.randomNonce()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch {
    return 'lost-race'; // someone else already evicted/released it first
  }

  const captured = readLeaseRecord(quarantinePath);
  const stillStale =
    captured === null ||
    isLeaseStale(captured, quarantinePath, deps, staleLeaseMs);
  if (stillStale) {
    try {
      fs.unlinkSync(quarantinePath);
    } catch {
      // already gone
    }
    return 'evicted';
  }

  // We captured a lease that turned out to be live after all (it was
  // (re)created between our earlier read and this rename) — restore it.
  // `link` is exclusive (EEXIST if lockPath already has something), so we
  // never clobber a fresh acquirer that has since legitimately claimed the
  // now-empty slot. KNOWN RESIDUAL GAP (documented in the module docstring,
  // LIA-454 EP-002 step 9 code review): `lockPath` is genuinely empty
  // between our `renameSync` above and this `linkSync` — if a fresh
  // acquirer's `wx`-create lands in that window, THIS restore fails EEXIST
  // (correctly, never clobbering them) but the captured lease we're
  // failing to restore is then unconditionally discarded below, silently
  // dropping its real (live, mid-turn) owner rather than self-healing —
  // that owner will NOT re-acquire on its own mid-turn. Accepted for this
  // still-caller-less module; must be closed (e.g. OS advisory locking) or
  // explicitly re-risk-accepted before a production caller is wired.
  try {
    fs.linkSync(quarantinePath, lockPath);
  } catch {
    // See the residual-gap note above — the captured lease's owner is
    // orphaned here, not self-healing.
    // LIA-459: purely additive observability for this documented, accepted
    // residual gap — no behavior/timing change. Converts a silent rare event
    // into a visible one now that this primitive backs the higher-traffic
    // raw-HTTP transport too, not just the CLI path's lower-traffic rollout.
    logger.warn(
      { threadHash: captured?.threadHash },
      'process-lifecycle-registry: orphaned a live lease during eviction restore — a fresh acquirer claimed the lockPath in the brief window between eviction and restore (documented residual restore-window race)',
    );
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch {
    // already gone
  }
  return 'lost-race';
}

/** One create-or-reclaim attempt. Returns the record that now owns the lease, or null if genuinely held by someone else (or the eviction race was lost — the caller's retry loop tries again). */
function attemptExclusiveLease(
  lockPath: string,
  buildRecord: () => LeaseRecord,
  deps: RegistryDeps,
  staleLeaseMs: number,
): LeaseRecord | null {
  const freshRecord = buildRecord();
  if (tryCreateLeaseFile(lockPath, freshRecord)) return freshRecord;

  const existing = readLeaseRecord(lockPath);
  const stale =
    existing === null || isLeaseStale(existing, lockPath, deps, staleLeaseMs);
  if (!stale) return null; // genuinely held by a live owner

  if (evictViaRename(lockPath, deps, staleLeaseMs) === 'lost-race') return null;

  const reclaimRecord = buildRecord();
  return tryCreateLeaseFile(lockPath, reclaimRecord) ? reclaimRecord : null;
}

/**
 * Removes the lease file ONLY if it is still ours (nonce match, verified
 * via the same rename-then-check sequence as reclaim) — never deletes a
 * lease another owner has since (re)claimed out from under us.
 */
function releaseLeaseFile(
  lockPath: string,
  nonce: string,
  deps: RegistryDeps,
): void {
  const quarantinePath = `${lockPath}.release-${deps.randomNonce()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch {
    return; // already gone — nothing to release
  }

  const captured = readLeaseRecord(quarantinePath);
  if (captured && captured.nonce === nonce) {
    try {
      fs.unlinkSync(quarantinePath);
    } catch {
      // already gone
    }
    return;
  }

  // We captured someone else's lease (ours was already judged stale and
  // reclaimed by another owner) — put it back rather than destroying it.
  // Same known residual gap as `evictViaRename`'s restore path: if a fresh
  // acquirer's `wx`-create lands in the window between our `renameSync`
  // and this `linkSync`, the restore fails EEXIST (never clobbering them)
  // but the lease we captured is then dropped below rather than restored.
  try {
    fs.linkSync(quarantinePath, lockPath);
  } catch {
    // See the residual-gap note above — the captured lease's owner is
    // orphaned here, not self-healing.
    // LIA-459: purely additive observability for this documented, accepted
    // residual gap — no behavior/timing change. Converts a silent rare event
    // into a visible one now that this primitive backs the higher-traffic
    // raw-HTTP transport too, not just the CLI path's lower-traffic rollout.
    logger.warn(
      { threadHash: captured?.threadHash },
      'process-lifecycle-registry: orphaned a live lease during release-path restore — a fresh acquirer claimed the lockPath in the brief window between capture and restore (documented residual restore-window race)',
    );
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch {
    // already gone
  }
}

function buildOwnerFields(
  deps: RegistryDeps,
): Pick<LeaseRecord, 'ownerPid' | 'ownerStartIdentity' | 'ownerCommandLine'> {
  const identity = deps.getProcessStartIdentity(process.pid);
  const cmd = deps.getProcessCommandLine(process.pid);
  return {
    ownerPid: process.pid,
    ownerStartIdentity: identity.status === 'found' ? identity.value : null,
    ownerCommandLine: cmd.status === 'found' ? cmd.value : null,
  };
}

/**
 * Acquire the exclusive turn lease for a thread. Callers on BOTH transports
 * (raw-HTTP and CLI-subprocess) must acquire this before their initial
 * checkpoint read and release it once the turn's checkpoint write is
 * durably persisted (success or failure) — this is what closes the
 * cross-process lost-update race a bare `SqliteSaver.put()` does not.
 * Returns null if the lease could not be acquired within `maxAttempts`
 * (the caller should surface this as "another turn is in flight for this
 * thread", never silently proceed without the lease).
 */
export async function acquireThreadTurnLease(
  threadId: string,
  options: AcquireLeaseOptions = {},
): Promise<ThreadTurnLease | null> {
  if (threadId.length === 0) {
    throw new ProcessLifecycleRegistryError(
      'acquireThreadTurnLease: threadId must not be empty',
    );
  }
  const deps: RegistryDeps = { ...defaultDeps(), ...options.deps };
  const rootDir = options.rootDir ?? STORE_DIR;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleLeaseMs = options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
  const minJitter = options.minRetryJitterMs ?? DEFAULT_MIN_RETRY_JITTER_MS;
  const maxJitter = options.maxRetryJitterMs ?? DEFAULT_MAX_RETRY_JITTER_MS;

  // Never store the raw thread/session id on disk — only its hash.
  const threadHash = crypto
    .createHash('sha256')
    .update(threadId, 'utf8')
    .digest('hex');
  const lockPath = path.join(
    threadTurnsDir(rootDir),
    `${threadHash}.lease.json`,
  );
  const buildRecord = (): LeaseRecord => ({
    kind: 'thread-turn',
    ...buildOwnerFields(deps),
    nonce: deps.randomNonce(),
    acquiredAtMs: deps.now(),
    threadHash,
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const record = attemptExclusiveLease(
      lockPath,
      buildRecord,
      deps,
      staleLeaseMs,
    );
    if (record) {
      return {
        threadHash,
        path: lockPath,
        release: () => releaseLeaseFile(lockPath, record.nonce, deps),
      };
    }
    if (attempt < maxAttempts - 1) {
      await deps.sleep(jitterDelayMs(minJitter, maxJitter));
    }
  }
  return null;
}

/**
 * Acquire one of a fixed pool of production-wide "claude CLI subprocess"
 * slots, bounding total concurrent CLI processes across every Deus process
 * instance on this host (the in-process `ClaudeCliSessionPool.maxProcesses`
 * cap only bounds a single instance). Tries slots in a randomized rotation
 * to spread contention, reclaiming any stale slot it finds along the way.
 * Returns null if no slot was free within `maxAttempts` rounds — the
 * caller must treat this as backpressure (queue/reject the spawn), never
 * spawn the subprocess anyway.
 */
export async function acquireProcessSlot(
  options: AcquireProcessSlotOptions = {},
): Promise<ProcessSlotLease | null> {
  const deps: RegistryDeps = { ...defaultDeps(), ...options.deps };
  const rootDir = options.rootDir ?? STORE_DIR;
  const slotCount = options.slotCount ?? DEFAULT_PROCESS_SLOT_COUNT;
  const maxRounds = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleLeaseMs = options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
  const minJitter = options.minRetryJitterMs ?? DEFAULT_MIN_RETRY_JITTER_MS;
  const maxJitter = options.maxRetryJitterMs ?? DEFAULT_MAX_RETRY_JITTER_MS;

  if (slotCount < 1) {
    throw new ProcessLifecycleRegistryError(
      'acquireProcessSlot: slotCount must be >= 1',
    );
  }

  const dir = processSlotsDir(rootDir);
  const startOffset = Math.floor(Math.random() * slotCount);

  for (let round = 0; round < maxRounds; round++) {
    for (let i = 0; i < slotCount; i++) {
      const slotIndex = (startOffset + i) % slotCount;
      const lockPath = path.join(dir, `slot-${slotIndex}.lease.json`);
      const buildRecord = (): LeaseRecord => ({
        kind: 'process-slot',
        ...buildOwnerFields(deps),
        nonce: deps.randomNonce(),
        acquiredAtMs: deps.now(),
      });
      const record = attemptExclusiveLease(
        lockPath,
        buildRecord,
        deps,
        staleLeaseMs,
      );
      if (record) {
        return {
          slotIndex,
          path: lockPath,
          release: () => releaseLeaseFile(lockPath, record.nonce, deps),
        };
      }
    }
    if (round < maxRounds - 1) {
      await deps.sleep(jitterDelayMs(minJitter, maxJitter));
    }
  }
  return null;
}
