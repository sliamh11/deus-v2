/**
 * Implementer tests for LIA-462 (companions to the independent oracle in
 * container-mounter.gate-isolation.test.ts). Cover the two lower-risk mechanical
 * properties the oracle intentionally does NOT assert:
 *   (a) concurrency — two gate runs on different PRs never collide on the
 *       /app/src staging destination nor the /home/node/.claude staging dir;
 *   (b) dispatch-untouched — isGateRun:false with a worktreePath set still
 *       produces byte-identical group-keyed, cwd-sourced harness/skills staging
 *       (only the pre-existing /workspace/project worktree-override changes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', async () => {
  const p = await import('path');
  const tmpBase = p.default.join(p.default.sep, 'tmp');
  const homeBase = p.default.join(p.default.sep, 'home', 'testuser');
  return {
    DATA_DIR: p.default.join(tmpBase, 'deus-data'),
    GROUPS_DIR: p.default.join(tmpBase, 'deus-groups'),
    HOME_DIR: homeBase,
    CONFIG_DIR: p.default.join(homeBase, '.config', 'deus'),
  };
});

vi.mock('./group-folder.js', async () => {
  const p = await import('path');
  const tmpBase = p.default.join(p.default.sep, 'tmp');
  return {
    resolveGroupFolderPath: vi.fn((folder: string) =>
      p.default.join(tmpBase, 'deus-groups', folder),
    ),
    resolveGroupIpcPath: vi.fn((folder: string, runKey?: string) =>
      p.default.join(
        tmpBase,
        'deus-data',
        'ipc',
        folder,
        ...(runKey ? [runKey] : []),
      ),
    ),
    assertValidGroupFolder: vi.fn(),
    isValidGroupFolder: vi.fn(() => true),
  };
});

vi.mock('./db.js', () => ({ getProjectById: vi.fn() }));
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));
vi.mock('./project-registry.js', () => ({
  SENSITIVE_FILE_PATTERNS: ['.env'],
  SENSITIVE_DIR_PATTERNS: ['credentials', 'secrets'],
}));
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      realpathSync: vi.fn((p: string) => p),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { buildVolumeMounts, type VolumeMount } from './container-mounter.js';
import type { RegisteredGroup } from './types.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockRealpathSync = vi.mocked(fs.realpathSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockCpSync = vi.mocked(fs.cpSync);

const TMP_BASE = path.join(path.sep, 'tmp');
const DATA_DIR = path.join(TMP_BASE, 'deus-data');

const makeGroup = (): RegisteredGroup => ({
  name: 'Dispatch Group',
  folder: 'linear-dispatch',
  trigger: '@Deus',
  added_at: '2024-01-01T00:00:00.000Z',
});

type BuildFn = (
  group: RegisteredGroup,
  isControlGroup: boolean,
  worktreePath?: string,
  ipcRunKey?: string,
  isGateRun?: boolean,
) => VolumeMount[];
const build = buildVolumeMounts as BuildFn;

function harnessSource(root: string): string {
  return path.join(root, 'container', 'agent-runner', 'src');
}

function hostPathFor(
  mounts: VolumeMount[],
  containerPath: string,
): string | undefined {
  return mounts.find((m) => m.containerPath === containerPath)?.hostPath;
}

// Make harness + skills sources "exist" under both cwd and every provided
// worktree so the staging blocks run.
function visibleUnder(...roots: string[]): void {
  const visible = new Set<string>();
  for (const r of roots) {
    visible.add(harnessSource(r));
    visible.add(path.join(r, 'container', 'skills'));
    visible.add(r);
  }
  mockExistsSync.mockImplementation((p) => visible.has(String(p)));
  mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockRealpathSync.mockImplementation((p) => String(p));
  mockReaddirSync.mockReturnValue([]);
});

describe('buildVolumeMounts: LIA-462 gate concurrency isolation', () => {
  it('two concurrent gates on different PRs never collide on /app/src or /home/node/.claude staging', () => {
    const group = makeGroup();
    const worktreeA = path.resolve(
      TMP_BASE,
      'gate-worktrees',
      'ISSUE-aaaa1111',
    );
    const worktreeB = path.resolve(
      TMP_BASE,
      'gate-worktrees',
      'ISSUE-bbbb2222',
    );

    visibleUnder(process.cwd(), worktreeA, worktreeB);

    const a = build(group, false, worktreeA, undefined, true);
    const b = build(group, false, worktreeB, undefined, true);

    const appA = hostPathFor(a, '/app/src');
    const appB = hostPathFor(b, '/app/src');
    const claudeA = hostPathFor(a, '/home/node/.claude');
    const claudeB = hostPathFor(b, '/home/node/.claude');

    expect(appA).toBeDefined();
    expect(appB).toBeDefined();
    expect(claudeA).toBeDefined();
    expect(claudeB).toBeDefined();

    // Per-run staging keyed by the worktree basename (== runToken) — distinct.
    expect(appA).not.toBe(appB);
    expect(claudeA).not.toBe(claudeB);
    expect(appA).toContain(path.join('gate-runs', 'ISSUE-aaaa1111'));
    expect(appB).toContain(path.join('gate-runs', 'ISSUE-bbbb2222'));
    expect(claudeA).toContain(path.join('gate-runs', 'ISSUE-aaaa1111'));
    expect(claudeB).toContain(path.join('gate-runs', 'ISSUE-bbbb2222'));
  });
});

describe('buildVolumeMounts: LIA-462 dispatch path untouched', () => {
  it('isGateRun:false with a worktreePath keeps byte-identical group-keyed, cwd-sourced staging', () => {
    const group = makeGroup();
    const worktree = path.resolve(TMP_BASE, 'worktrees', 'FEAT-1');
    visibleUnder(process.cwd(), worktree);

    // Baseline: today's plain non-gate call, no worktree at all.
    const baseline = build(group, false);
    const baselineApp = hostPathFor(baseline, '/app/src');
    const baselineClaude = hostPathFor(baseline, '/home/node/.claude');
    const baselineCopySources = mockCpSync.mock.calls.map(([s]) => String(s));

    vi.clearAllMocks();
    visibleUnder(process.cwd(), worktree);

    // Same call but WITH a worktree and isGateRun:false (a dispatch/implement run).
    const withWorktree = build(group, false, worktree, undefined, false);
    const wtApp = hostPathFor(withWorktree, '/app/src');
    const wtClaude = hostPathFor(withWorktree, '/home/node/.claude');
    const wtCopySources = mockCpSync.mock.calls.map(([s]) => String(s));

    // Harness/skills staging destinations are the standard group-keyed dirs —
    // identical to the no-worktree baseline (the worktree only changes the
    // pre-existing /workspace/project override, not the harness/skills staging).
    expect(wtApp).toBe(baselineApp);
    expect(wtApp).toBe(
      path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src'),
    );
    expect(wtClaude).toBe(baselineClaude);
    expect(wtClaude).toBe(
      path.join(DATA_DIR, 'sessions', group.folder, '.claude'),
    );

    // And the staged SOURCES are the daemon cwd, never the worktree — byte-identical.
    expect(wtCopySources).toEqual(baselineCopySources);
    expect(wtCopySources).toContain(harnessSource(process.cwd()));
    expect(wtCopySources).not.toContain(harnessSource(worktree));

    // Sanity: the worktree IS mounted at /workspace/project (existing override).
    expect(hostPathFor(withWorktree, '/workspace/project')).toBe(worktree);
  });
});
