/**
 * File-based side channel carrying nested-dispatch child usage across the
 * process boundary (LIA-460), from `parent-turn-mcp-server.ts`'s own
 * subprocess (where a `dispatch_nested_agent` child CLI turn actually runs
 * and its usage is parsed) back to the HOST process (`parent-turn-runner.ts`,
 * which folds it into `RunResult.usage`).
 *
 * A first design (stuffing an extra field into the MCP tool-result JSON) was
 * investigated and confirmed non-viable: the real `claude` CLI's own
 * `tool_result` stream-json event schema is fixed to exactly `{type,
 * tool_use_id, content, is_error}` (see `stream-json-protocol.ts`'s
 * `ToolResultContentBlock`) — any extra field would be silently dropped by
 * the CLI itself before the host ever parses the event. This module is a
 * plain file instead: both the writer (inside the MCP server subprocess) and
 * the reader (the host) are told the SAME scratch directory explicitly via
 * the `DEUS_PARENT_SCRATCH_DIR` env var (the same `mcpServerEnv` channel
 * already proven reliable for `DEUS_PARENT_TURN_CONTEXT`) — never inferred
 * from `process.cwd()`, since `McpScratchConfig`'s spawn schema
 * (`claude-cli-session-pool.ts`) has no `cwd` field at all for the declared
 * MCP server, so this repo has no control over (or visibility into) what
 * cwd that grandchild process actually gets.
 *
 * INVARIANT: every fs touch in the writer path (`appendNestedDispatchUsage`)
 * must stay conditional on the caller actually having a scratch directory to
 * write to — never called unconditionally by a dispatcher that omits its
 * `usageScratchDir` dep. This keeps every existing `CliSubprocessNestedDispatcherDeps`
 * test construction (plain object literals, no `usageScratchDir`, no fs
 * mocking) genuinely opt-in and untouched by this addition.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { TranscriptUsageEvent } from '../transcript-store.js';

export const NESTED_DISPATCH_USAGE_FILENAME = 'nested-dispatch-usage.jsonl';

/** Structural guard for a parsed JSONL line — the writer is the only trusted
 *  producer of this file, but a shape check costs little and turns a
 *  corrupted-but-valid-JSON line into a skip rather than a malformed entry
 *  silently reaching `usageCollector.recordRaw()`. */
function isTranscriptUsageEventShaped(
  value: unknown,
): value is TranscriptUsageEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { provider?: unknown }).provider === 'string' &&
    typeof (value as { model?: unknown }).model === 'string'
  );
}

/**
 * Appends one usage entry as a JSON line. Sync (matches this transport's
 * other scratch-file writes, e.g. `parent-turn-runner.ts`'s history file) and
 * best-effort — catches and swallows any fs error, since a usage-accounting
 * side channel must never fail the real dispatch it's observing.
 */
export function appendNestedDispatchUsage(
  scratchDir: string,
  entry: TranscriptUsageEvent,
): void {
  try {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.appendFileSync(
      path.join(scratchDir, NESTED_DISPATCH_USAGE_FILENAME),
      JSON.stringify(entry) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Best-effort — never let a usage-accounting side channel fail the real
    // dispatch it's observing.
  }
}

/**
 * Reads every usage entry written this turn and deletes the file. Returns
 * `[]` when the file doesn't exist (the common case: no nested dispatch
 * happened this turn, OR a prior call in this same turn already cleared
 * it) — never throws. A malformed or wrong-shaped line is skipped rather
 * than crashing the whole read or reaching `usageCollector.recordRaw()`
 * with garbage; one corrupt line does not need to cost every other real
 * entry in the file.
 *
 * Callers must invoke this UNCONDITIONALLY on every turn outcome (success
 * AND error), not just the success path — `parent-turn-runner.ts` does so
 * in its own `finally` block, mirroring its `historyFilePath` cleanup
 * precedent, so a turn that errors after a nested dispatch already wrote
 * usage can never leave an orphaned entry to bleed into a later turn.
 */
export function readAndClearNestedDispatchUsage(
  scratchDir: string,
): TranscriptUsageEvent[] {
  const filePath = path.join(scratchDir, NESTED_DISPATCH_USAGE_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }

  const entries: TranscriptUsageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTranscriptUsageEventShaped(parsed)) entries.push(parsed);
    } catch {
      // Skip a malformed line rather than losing every other real entry.
    }
  }
  return entries;
}
