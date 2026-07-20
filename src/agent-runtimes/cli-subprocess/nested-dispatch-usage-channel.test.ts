/**
 * LIA-460: tests for the nested-dispatch usage file-based side channel.
 * Real fs against a real tmpdir, matching this transport's other
 * scratch-file tests (e.g. `process-lifecycle-registry.test.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  NESTED_DISPATCH_USAGE_FILENAME,
  appendNestedDispatchUsage,
  readAndClearNestedDispatchUsage,
} from './nested-dispatch-usage-channel.js';
import type { TranscriptUsageEvent } from '../transcript-store.js';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lia460-usage-channel-'));
});
afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('nested-dispatch-usage-channel', () => {
  it('readAndClearNestedDispatchUsage returns [] when the file does not exist, without throwing', () => {
    expect(readAndClearNestedDispatchUsage(scratchRoot)).toEqual([]);
  });

  it('round-trips a single entry and deletes the file after reading', () => {
    const entry: TranscriptUsageEvent = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 12_345,
      outputTokens: 42,
      totalTokens: 12_387,
    };
    appendNestedDispatchUsage(scratchRoot, entry);

    const filePath = path.join(scratchRoot, NESTED_DISPATCH_USAGE_FILENAME);
    expect(fs.existsSync(filePath)).toBe(true);

    const entries = readAndClearNestedDispatchUsage(scratchRoot);
    expect(entries).toEqual([entry]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('accumulates multiple appended entries (multiple dispatches in one turn) into one JSONL read', () => {
    const first: TranscriptUsageEvent = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    };
    const second: TranscriptUsageEvent = {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
    };
    appendNestedDispatchUsage(scratchRoot, first);
    appendNestedDispatchUsage(scratchRoot, second);

    expect(readAndClearNestedDispatchUsage(scratchRoot)).toEqual([
      first,
      second,
    ]);
  });

  it('skips a malformed line rather than losing every other real entry', () => {
    fs.mkdirSync(scratchRoot, { recursive: true });
    const filePath = path.join(scratchRoot, NESTED_DISPATCH_USAGE_FILENAME);
    const valid: TranscriptUsageEvent = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(valid)}\nnot valid json\n${JSON.stringify(valid)}\n`,
    );

    expect(readAndClearNestedDispatchUsage(scratchRoot)).toEqual([
      valid,
      valid,
    ]);
  });

  it('skips a valid-JSON but wrong-shaped line (e.g. missing provider/model) rather than reaching the caller with garbage', () => {
    fs.mkdirSync(scratchRoot, { recursive: true });
    const filePath = path.join(scratchRoot, NESTED_DISPATCH_USAGE_FILENAME);
    const valid: TranscriptUsageEvent = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(valid)}\n${JSON.stringify({ inputTokens: 999 })}\n`,
    );

    expect(readAndClearNestedDispatchUsage(scratchRoot)).toEqual([valid]);
  });

  it('appendNestedDispatchUsage never throws even against an unwritable path', () => {
    // A path segment that cannot be created (a file, not a dir, in the way)
    // — appendNestedDispatchUsage must swallow this, matching its own
    // best-effort contract (a usage-accounting side channel must never fail
    // the real dispatch it's observing).
    const blockerFile = path.join(scratchRoot, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    const impossibleDir = path.join(blockerFile, 'nested');

    expect(() =>
      appendNestedDispatchUsage(impossibleDir, {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).not.toThrow();
  });
});
