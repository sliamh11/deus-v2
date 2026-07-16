/**
 * B4 (LIA-404): the LangGraph checkpointer singleton for the `deus-native`
 * backend.
 *
 * The `SqliteSaver` lives in its OWN SQLite file (`checkpoints.db`, a sibling
 * of `messages.db` inside STORE_DIR) — deliberately NOT sharing `db.ts`'s
 * module-private connection. `db.ts` exports no raw-connection accessor
 * (every access goes through its own wrapper functions), and reaching into
 * that encapsulation to share one connection would be a bigger, riskier
 * change than LIA-404's ACs ask for (plus an unverified async-lock
 * coordination risk between LangGraph's writes and Deus's own). SQLite
 * handles independent connections to different files with zero coordination
 * concerns. See the B4 plan's "Where the checkpointer's own SQLite state
 * should live" research note.
 *
 * `no-db-deletion` ADR compliance: nothing in this module (or its callers)
 * ever calls `deleteThread` or any other delete path — checkpoint rows
 * accumulate the same way Deus's own soft-deleted rows do. Cleanup/expiry of
 * accumulated checkpoints is a known, accepted, explicitly-deferred concern.
 */

import path from 'path';

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
// Type-only import: `@langchain/langgraph-checkpoint` is the direct
// dependency of `@langchain/langgraph-checkpoint-sqlite` that declares the
// abstract saver interface `createAgent({checkpointer})` accepts. Erased at
// compile time — no runtime import of the transitive package.
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { STORE_DIR } from '../config.js';

/** Resolves the checkpointer's dedicated SQLite file inside STORE_DIR. */
export function resolveCheckpointerDbPath(): string {
  return path.join(STORE_DIR, 'checkpoints.db');
}

let cached: BaseCheckpointSaver | undefined;

/**
 * Memoized singleton getter. A `SqliteSaver` wraps a genuine stateful DB
 * connection that should be opened once and reused — repeatedly reopening a
 * sqlite file handle every turn is wasteful and risks file-handle exhaustion
 * under load (contrast `buildProxyRoutedChatAnthropic`, which IS rebuilt per
 * turn because it's stateless).
 *
 * `dbPathOverride` exists for TESTABILITY, not production use: production
 * call sites always call `getCheckpointer()` with no argument. The parameter
 * is the deliberate alternative to mocking `resolveCheckpointerDbPath` —
 * both functions live in this same file, and same-module self-mocking does
 * NOT rewire same-file function references in ESM/Vitest, so a mock-based
 * design would silently keep using the real path (a real defect caught in
 * plan review; do not "simplify" this parameter away).
 *
 * Memoization wins over the argument: only the FIRST call after module load
 * (or after `_resetCheckpointerForTests()`) determines the underlying file;
 * every subsequent call returns the same instance regardless of argument.
 * No manual setup/init call is needed — SqliteSaver's tables self-migrate
 * lazily on first use (CREATE TABLE IF NOT EXISTS, guarded by an isSetup
 * flag).
 */
export function getCheckpointer(dbPathOverride?: string): BaseCheckpointSaver {
  if (!cached) {
    cached = SqliteSaver.fromConnString(
      dbPathOverride ?? resolveCheckpointerDbPath(),
    );
  }
  return cached;
}

/**
 * Test-only (matching `_initTestDatabase`'s `_`-prefix convention in db.ts):
 * resets the memoized singleton so each test can point `getCheckpointer` at
 * its own fresh temp file. Production code never calls this.
 */
export function _resetCheckpointerForTests(): void {
  // Close the underlying better-sqlite3 handle before dropping the
  // reference. On POSIX a leaked handle is harmless (the OS reclaims it),
  // but on Windows a still-open sqlite file blocks a subsequent
  // fs.rmSync/unlink in test cleanup with EBUSY — closing it here avoids
  // that cascade across checkpointer.test.ts,
  // deus-native-checkpointer-integration.test.ts, and lifecycle-events.test.ts.
  (cached as SqliteSaver | undefined)?.db.close();
  cached = undefined;
}
