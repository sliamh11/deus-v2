/**
 * Independent oracle for LIA-462: gate containers must stage the harness and
 * bundled skills from the PR-head worktree, without changing ordinary runs.
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

vi.mock('./db.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./project-registry.js', () => ({
  SENSITIVE_FILE_PATTERNS: ['.env', '.env.local', '.env.production'],
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
const SENTINEL_SKILL = 'gate-isolation-sentinel';

const makeGroup = (): RegisteredGroup => ({
  name: 'Gate Isolation Group',
  folder: 'gate-isolation-group',
  trigger: '@Deus',
  added_at: '2024-01-01T00:00:00.000Z',
});

type BuildVolumeMountsWithGateFlag = (
  group: RegisteredGroup,
  isControlGroup: boolean,
  worktreePath?: string,
  ipcRunKey?: string,
  isGateRun?: boolean,
) => VolumeMount[];

const buildVolumeMountsWithGateFlag =
  buildVolumeMounts as BuildVolumeMountsWithGateFlag;

function harnessSource(root: string): string {
  return path.join(root, 'container', 'agent-runner', 'src');
}

function skillsSource(root: string): string {
  return path.join(root, 'container', 'skills');
}

function sentinelSkillSource(root: string): string {
  return path.join(skillsSource(root), SENTINEL_SKILL);
}

function configureVisibleSources(worktreePath?: string): void {
  const visiblePaths = new Set([
    harnessSource(process.cwd()),
    skillsSource(process.cwd()),
  ]);

  if (worktreePath) {
    visiblePaths.add(worktreePath);
    visiblePaths.add(harnessSource(worktreePath));
    visiblePaths.add(skillsSource(worktreePath));
  }

  mockExistsSync.mockImplementation((candidate) =>
    visiblePaths.has(String(candidate)),
  );

  mockReaddirSync.mockImplementation(((candidate: fs.PathLike) => {
    const source = String(candidate);
    if (
      source === skillsSource(process.cwd()) ||
      (worktreePath && source === skillsSource(worktreePath))
    ) {
      return [SENTINEL_SKILL];
    }
    return [];
  }) as typeof fs.readdirSync);

  mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
}

function copySources(): string[] {
  return mockCpSync.mock.calls.map(([source]) => String(source));
}

// Contract-level reconciliation (LIA-462, implementer note): the oracle was
// authored blind to the per-run staging DESTINATION that the concurrency fix
// (round-1 blocking finding) introduces for gate runs, so its original form
// hardcoded the group-keyed `.claude/skills` path. That path is an internal
// detail, not the source-isolation contract under test. Derive the skills
// destination from the actual `/home/node/.claude` mount's hostPath — exactly
// as the harness assertions derive from the `/app/src` mount's hostPath — so
// the discriminating SOURCE assertion (worktree vs daemon cwd) stays fully
// intact and red-on-old-code, while the assertion no longer over-specifies the
// destination the gate-isolation fix legitimately makes per-run.
function expectedSkillDestination(mounts: VolumeMount[]): string {
  const claudeMount = mounts.find(
    (mount) => mount.containerPath === '/home/node/.claude',
  );
  if (!claudeMount) {
    throw new Error('expected a /home/node/.claude mount');
  }
  return path.join(claudeMount.hostPath, 'skills', SENTINEL_SKILL);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockRealpathSync.mockImplementation((candidate) => String(candidate));
  mockReaddirSync.mockReturnValue([]);
});

describe('buildVolumeMounts: gate source isolation (LIA-462)', () => {
  // @oracle: LIA-462 gate runs stage /app/src and bundled skills from the PR-head worktree.
  it('stages gate harness and skills from the worktree, never the daemon cwd', () => {
    const group = makeGroup();
    const worktreePath = path.resolve(TMP_BASE, 'lia-462-pr-head');
    configureVisibleSources(worktreePath);

    const mounts = buildVolumeMountsWithGateFlag(
      group,
      false,
      worktreePath,
      undefined,
      true,
    );

    const appSourceMount = mounts.find(
      (mount) => mount.containerPath === '/app/src',
    );
    expect(appSourceMount).toBeDefined();

    expect(mockCpSync).toHaveBeenCalledWith(
      harnessSource(worktreePath),
      appSourceMount!.hostPath,
      { recursive: true },
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      sentinelSkillSource(worktreePath),
      expectedSkillDestination(mounts),
      { recursive: true },
    );

    expect(copySources()).not.toContain(harnessSource(process.cwd()));
    expect(copySources()).not.toContain(sentinelSkillSource(process.cwd()));
  });

  // @oracle: LIA-462 non-gate runs keep daemon-cwd staging even when a worktree exists.
  it('keeps daemon-cwd harness and skills for a non-gate worktree run', () => {
    const group = makeGroup();
    const worktreePath = path.resolve(TMP_BASE, 'lia-462-non-gate-worktree');
    configureVisibleSources(worktreePath);

    const mounts = buildVolumeMountsWithGateFlag(
      group,
      false,
      worktreePath,
      undefined,
      false,
    );

    const appSourceMount = mounts.find(
      (mount) => mount.containerPath === '/app/src',
    );
    expect(appSourceMount).toBeDefined();

    expect(mockCpSync).toHaveBeenCalledWith(
      harnessSource(process.cwd()),
      appSourceMount!.hostPath,
      { recursive: true },
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      sentinelSkillSource(process.cwd()),
      expectedSkillDestination(mounts),
      { recursive: true },
    );

    expect(copySources()).not.toContain(harnessSource(worktreePath));
    expect(copySources()).not.toContain(sentinelSkillSource(worktreePath));
  });

  // @oracle: LIA-462 default invocations preserve daemon-cwd staging.
  it('keeps daemon-cwd harness and skills when no worktree is provided', () => {
    const group = makeGroup();
    configureVisibleSources();

    const mounts = buildVolumeMountsWithGateFlag(group, false);

    const appSourceMount = mounts.find(
      (mount) => mount.containerPath === '/app/src',
    );
    expect(appSourceMount).toBeDefined();

    expect(mockCpSync).toHaveBeenCalledWith(
      harnessSource(process.cwd()),
      appSourceMount!.hostPath,
      { recursive: true },
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      sentinelSkillSource(process.cwd()),
      expectedSkillDestination(mounts),
      { recursive: true },
    );
  });

  // @oracle: LIA-462 gate source substitution requires a worktree as well as the gate flag.
  it('keeps daemon-cwd harness and skills for a gate run without a worktree', () => {
    const group = makeGroup();
    configureVisibleSources();

    const mounts = buildVolumeMountsWithGateFlag(
      group,
      false,
      undefined,
      undefined,
      true,
    );

    const appSourceMount = mounts.find(
      (mount) => mount.containerPath === '/app/src',
    );
    expect(appSourceMount).toBeDefined();

    expect(mockCpSync).toHaveBeenCalledWith(
      harnessSource(process.cwd()),
      appSourceMount!.hostPath,
      { recursive: true },
    );
    expect(mockCpSync).toHaveBeenCalledWith(
      sentinelSkillSource(process.cwd()),
      expectedSkillDestination(mounts),
      { recursive: true },
    );
  });
});
