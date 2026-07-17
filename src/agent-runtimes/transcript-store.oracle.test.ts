/**
 * Oracle tests for LIA-427/F5 — Deus-native transcript persistence.
 *
 * @oracle Independently authored from the SHIP'd public interface contract in
 * f5-plan.md, BLIND to the writer implementation (transcript-store.ts did not
 * exist when this file was authored). This oracle must not be weakened by the
 * implementer. A contract change requires independent review and equally
 * protective or stronger assertions.
 *
 * The public contract under test is deliberately narrow: the two resolvers and
 * appendDeusNativeTranscriptTurn(). These tests use a real temporary filesystem
 * and make no assertions about private serializer or queue helpers.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IS_WINDOWS } from '../platform.js';
import {
  appendDeusNativeTranscriptTurn,
  resolveDeusNativeTranscriptPath,
  resolveDeusNativeTranscriptRoot,
  type TranscriptTurnInput,
} from './transcript-store.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'deus-transcript-oracle-'),
  );
  temporaryRoots.push(root);
  return root;
}

function turn(
  overrides: Partial<TranscriptTurnInput> = {},
): TranscriptTurnInput {
  return {
    sessionId: 'oracle-session',
    groupFolder: 'oracle_group',
    cwd: '/private/oracle/project',
    prompt: 'Oracle prompt that must be persisted exactly once.',
    assistantText: 'Oracle response that must be persisted exactly once.',
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    primaryModel: 'claude-sonnet-4-5',
    toolCalls: [],
    usageEvents: [],
    startedAt: new Date('2026-07-17T12:00:00.000Z'),
    completedAt: new Date('2026-07-17T12:00:02.000Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('@oracle transcript-store path confinement', () => {
  it('hashes an adversarial session id into one direct child of the native root', async () => {
    const rootDir = temporaryRoot();
    const sessionId = '../../outside/../session\\name';
    const expectedName = `${crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex')}.jsonl`;
    const expectedRoot = path.join(rootDir, 'transcripts', 'deus-native');
    const resolvedRoot = resolveDeusNativeTranscriptRoot(rootDir);
    const resolvedPath = resolveDeusNativeTranscriptPath(sessionId, {
      rootDir,
    });

    expect(path.resolve(resolvedRoot)).toBe(path.resolve(expectedRoot));
    expect(path.dirname(resolvedPath)).toBe(expectedRoot);
    expect(path.basename(resolvedPath)).toBe(expectedName);
    expect(path.relative(expectedRoot, resolvedPath)).toBe(expectedName);

    const result = await appendDeusNativeTranscriptTurn(turn({ sessionId }), {
      rootDir,
    });
    expect(result).toEqual({ ok: true, path: resolvedPath });
    expect(fs.existsSync(resolvedPath)).toBe(true);

    const files = fs.readdirSync(expectedRoot);
    expect(files).toEqual([expectedName]);
    expect(
      fs.existsSync(path.resolve(rootDir, '../../outside/../session\\name')),
    ).toBe(false);
  });
});

describe('@oracle transcript-store append-only bytes', () => {
  it('preserves the first complete two-line payload byte-for-byte when appending a second turn', async () => {
    const rootDir = temporaryRoot();
    const sessionId = 'append-only-oracle';
    const first = await appendDeusNativeTranscriptTurn(
      turn({ sessionId, prompt: 'First oracle prompt.' }),
      { rootDir },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const firstBytes = fs.readFileSync(first.path);
    expect(firstBytes.at(-1)).toBe('\n'.charCodeAt(0));
    expect(firstBytes.toString('utf8').trimEnd().split('\n')).toHaveLength(2);

    const second = await appendDeusNativeTranscriptTurn(
      turn({
        sessionId,
        prompt: 'Second oracle prompt.',
        startedAt: new Date('2026-07-17T12:01:00.000Z'),
        completedAt: new Date('2026-07-17T12:01:02.000Z'),
      }),
      { rootDir },
    );
    expect(second).toEqual({ ok: true, path: first.path });

    const combined = fs.readFileSync(first.path);
    expect(combined.subarray(0, firstBytes.length).equals(firstBytes)).toBe(
      true,
    );
    expect(combined.length).toBeGreaterThan(firstBytes.length);
    expect(combined.at(-1)).toBe('\n'.charCodeAt(0));
    expect(combined.toString('utf8').trimEnd().split('\n')).toHaveLength(4);
  });
});

describe('@oracle transcript-store real filesystem permissions', () => {
  it.skipIf(IS_WINDOWS)(
    'leaves the native directory at 0700 and transcript at 0600',
    async () => {
      const rootDir = temporaryRoot();
      const result = await appendDeusNativeTranscriptTurn(turn(), { rootDir });
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;

      expect(
        fs.statSync(resolveDeusNativeTranscriptRoot(rootDir)).mode & 0o777,
      ).toBe(0o700);
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    },
  );
});

describe('@oracle transcript-store fail-open boundary', () => {
  it('returns ok:false without rejecting and cannot alter prepared backend output/events', async () => {
    const rootDir = temporaryRoot();
    const rootIsAFile = path.join(rootDir, 'not-a-directory');
    fs.writeFileSync(rootIsAFile, 'occupied');

    const terminalEvents = ['output_text', 'turn_complete'];
    const preparedRunResult = {
      status: 'success' as const,
      result: 'Successful backend answer.',
      sessionRef: {
        backend: 'deus-native' as const,
        session_id: 'oracle-session',
      },
    };
    const warn = vi.fn();

    const writePromise = appendDeusNativeTranscriptTurn(turn(), {
      rootDir: rootIsAFile,
      warn,
    });
    await expect(writePromise).resolves.toMatchObject({ ok: false });
    const writeResult = await writePromise;

    expect(writeResult.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(terminalEvents).toEqual(['output_text', 'turn_complete']);
    expect(preparedRunResult).toEqual({
      status: 'success',
      result: 'Successful backend answer.',
      sessionRef: { backend: 'deus-native', session_id: 'oracle-session' },
    });
    expect(fs.readFileSync(rootIsAFile, 'utf8')).toBe('occupied');
  });
});
