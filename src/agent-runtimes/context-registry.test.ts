import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, RegisteredGroup } from '../types.js';
import {
  loadRegisteredContextFiles,
  type ContextRegistryDeps,
} from './context-registry.js';
import type { RunContext } from './types.js';
import type { VaultContextRecord } from './vault-context.js';

const FILES = ['AGENTS.md', 'CLAUDE.md', 'AI_AGENT_GUIDELINES.md'] as const;

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: 'deus',
    added_at: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    prompt: 'hello',
    cwd: '/ignored/cwd',
    groupFolder: 'test-group',
    chatJid: 'test@g.us',
    isControlGroup: false,
    ...overrides,
  };
}

function makeVaultRecord(
  overrides: Partial<VaultContextRecord> = {},
): VaultContextRecord {
  return {
    eligible: true,
    vaultAvailable: false,
    contextLoaded: false,
    loadedSections: [],
    loadedVaultFiles: [],
    ...overrides,
  };
}

function makeProject(id: string, projectPath: string): ProjectConfig {
  return {
    id,
    name: id,
    path: projectPath,
    type: null,
    readonly: true,
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

describe('host context registry', () => {
  let root: string;
  let groupsRoot: string;
  let groupRoot: string;
  let globalRoot: string;
  let worktreeRoot: string;
  let projectRoot: string;
  let daemonRoot: string;
  let vaultRoot: string;
  let cwdRoot: string;
  let extraAlpha: string;
  let extraZulu: string;
  let config: Record<string, unknown>;
  let projects: Map<string, ProjectConfig>;
  let validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
  let deps: ContextRegistryDeps;
  let originalMaxChars: string | undefined;

  function mkdir(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeFile(dir: string, filename: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
  }

  function writeAll(dir: string, prefix: string): void {
    for (const filename of FILES) {
      writeFile(dir, filename, `${prefix}-${filename}`);
    }
  }

  function labels(
    context: RunContext,
    group: RegisteredGroup | undefined = makeGroup(),
    vaultRecord: VaultContextRecord = makeVaultRecord(),
  ): string[] {
    return loadRegisteredContextFiles(context, group, vaultRecord, deps).map(
      ({ label }) => label,
    );
  }

  function blocks(
    context: RunContext,
    group: RegisteredGroup | undefined = makeGroup(),
    vaultRecord: VaultContextRecord = makeVaultRecord(),
  ): string[] {
    return loadRegisteredContextFiles(context, group, vaultRecord, deps).map(
      ({ block }) => block,
    );
  }

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lia-418-context-registry-')),
    );
    groupsRoot = mkdir('groups');
    groupRoot = mkdir('groups/test-group');
    globalRoot = mkdir('groups/global');
    worktreeRoot = mkdir('worktree');
    projectRoot = mkdir('registered-project');
    daemonRoot = mkdir('daemon-root');
    vaultRoot = mkdir('vault');
    cwdRoot = mkdir('cwd-only');
    extraAlpha = mkdir('extra-alpha');
    extraZulu = mkdir('extra-zulu');
    config = { vault_autoload: FILES };
    projects = new Map();
    validatedMounts = [];
    deps = {
      resolveGroupFolder: (folder) => path.join(groupsRoot, folder),
      getProject: (id) => projects.get(id),
      validateMounts: () => validatedMounts,
      readConfig: () => config,
      resolveVault: () => vaultRoot,
      projectRoot: daemonRoot,
    };
    originalMaxChars = process.env.DEUS_CONTEXT_FILE_MAX_CHARS;
    delete process.env.DEUS_CONTEXT_FILE_MAX_CHARS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMaxChars === undefined) {
      delete process.env.DEUS_CONTEXT_FILE_MAX_CHARS;
    } else {
      process.env.DEUS_CONTEXT_FILE_MAX_CHARS = originalMaxChars;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads non-control scopes in fixed scope, mount-name, and filename order', () => {
    writeAll(groupRoot, 'group');
    writeAll(globalRoot, 'global');
    writeAll(projectRoot, 'project');
    writeAll(extraAlpha, 'alpha');
    writeAll(extraZulu, 'zulu');
    projects.set('project-1', makeProject('project-1', projectRoot));
    validatedMounts = [
      {
        hostPath: extraZulu,
        containerPath: '/workspace/extra/zulu',
        readonly: true,
      },
      {
        hostPath: extraAlpha,
        containerPath: '/workspace/extra/alpha',
        readonly: true,
      },
    ];
    const group = makeGroup({
      projectId: 'project-1',
      containerConfig: {
        additionalMounts: [{ hostPath: extraZulu }, { hostPath: extraAlpha }],
      },
    });

    expect(labels(makeContext(), group)).toEqual([
      ...FILES.map((file) => `GROUP RULES: ${file}`),
      ...FILES.map((file) => `GLOBAL RULES: ${file}`),
      ...FILES.map((file) => `PROJECT RULES: ${file}`),
      ...FILES.map((file) => `EXTRA RULES: alpha/${file}`),
      ...FILES.map((file) => `EXTRA RULES: zulu/${file}`),
    ]);
  });

  it('loads all control-group scopes except global and formats every block exactly', () => {
    writeAll(groupRoot, 'group');
    writeAll(globalRoot, 'global');
    writeAll(worktreeRoot, 'worktree');
    writeAll(vaultRoot, 'vault');
    writeAll(extraAlpha, 'alpha');
    validatedMounts = [
      {
        hostPath: extraAlpha,
        containerPath: '/workspace/extra/alpha',
        readonly: false,
      },
    ];
    const group = makeGroup({
      containerConfig: { additionalMounts: [{ hostPath: extraAlpha }] },
    });

    const result = loadRegisteredContextFiles(
      makeContext({ isControlGroup: true, worktreePath: worktreeRoot }),
      group,
      makeVaultRecord(),
      deps,
    );
    expect(result.map(({ label }) => label)).toEqual([
      ...FILES.map((file) => `GROUP RULES: ${file}`),
      ...FILES.map((file) => `PROJECT RULES: ${file}`),
      ...FILES.map((file) => `VAULT: ${file}`),
      ...FILES.map((file) => `EXTRA RULES: alpha/${file}`),
    ]);
    expect(result[0]).toEqual({
      label: 'GROUP RULES: AGENTS.md',
      block: '=== GROUP RULES: AGENTS.md ===\ngroup-AGENTS.md',
    });
    expect(result.some(({ label }) => label.startsWith('GLOBAL'))).toBe(false);
  });

  it('applies the configured truncation cap and keeps AGENTS.md before the compatibility mirror', () => {
    process.env.DEUS_CONTEXT_FILE_MAX_CHARS = '5';
    writeFile(groupRoot, 'AGENTS.md', '123456789');
    writeFile(groupRoot, 'CLAUDE.md', 'abcdefghi');

    expect(
      loadRegisteredContextFiles(
        makeContext(),
        makeGroup(),
        makeVaultRecord(),
        deps,
      ),
    ).toEqual([
      {
        label: 'GROUP RULES: AGENTS.md',
        block: '=== GROUP RULES: AGENTS.md ===\n12345',
      },
      {
        label: 'GROUP RULES: CLAUDE.md',
        block: '=== GROUP RULES: CLAUDE.md ===\nabcde',
      },
    ]);
  });

  it('inspects only registered roots and never recursively discovers nested files', () => {
    writeFile(groupRoot, 'CLAUDE.md', 'root-rules');
    writeAll(path.join(groupRoot, 'nested'), 'nested');
    writeFile(extraAlpha, 'AGENTS.md', 'extra-root');
    writeAll(path.join(extraAlpha, 'nested'), 'extra-nested');
    validatedMounts = [
      {
        hostPath: extraAlpha,
        containerPath: '/workspace/extra/alpha',
        readonly: true,
      },
    ];
    const group = makeGroup({
      containerConfig: { additionalMounts: [{ hostPath: extraAlpha }] },
    });

    const result = blocks(makeContext(), group).join('\n');
    expect(result).toContain('root-rules');
    expect(result).toContain('extra-root');
    expect(result).not.toContain('nested-');
  });

  it('continues after missing, empty, unreadable, and concurrently removed files', () => {
    writeFile(groupRoot, 'AGENTS.md', 'keep-group');
    writeFile(groupRoot, 'CLAUDE.md', 'unreadable');
    writeFile(groupRoot, 'AI_AGENT_GUIDELINES.md', 'remove-during-read');
    writeFile(globalRoot, 'AGENTS.md', 'keep-global');
    writeFile(globalRoot, 'CLAUDE.md', '');
    const unreadablePath = path.join(groupRoot, 'CLAUDE.md');
    const removedPath = path.join(groupRoot, 'AI_AGENT_GUIDELINES.md');
    const originalRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (filePath === unreadablePath) throw new Error('EACCES');
      if (filePath === removedPath) {
        fs.rmSync(removedPath);
        throw new Error('ENOENT');
      }
      return originalRead(filePath, ...(args as [never]));
    }) as typeof fs.readFileSync);

    expect(() => labels(makeContext())).not.toThrow();
    expect(labels(makeContext())).toEqual([
      'GROUP RULES: AGENTS.md',
      'GLOBAL RULES: AGENTS.md',
    ]);
  });

  describe('project resolution', () => {
    beforeEach(() => {
      writeFile(worktreeRoot, 'CLAUDE.md', 'worktree-sentinel');
      writeFile(projectRoot, 'CLAUDE.md', 'project-sentinel');
      writeFile(cwdRoot, 'CLAUDE.md', 'cwd-sentinel');
      writeFile(daemonRoot, 'CLAUDE.md', 'daemon-sentinel');
      projects.set('project-1', makeProject('project-1', projectRoot));
    });

    it('uses a valid worktree before the registered project and ignores cwd', () => {
      const result = blocks(
        makeContext({
          cwd: cwdRoot,
          worktreePath: worktreeRoot,
          isControlGroup: true,
        }),
        makeGroup({ projectId: 'project-1' }),
      ).join('\n');
      expect(result).toContain('worktree-sentinel');
      expect(result).not.toContain('project-sentinel');
      expect(result).not.toContain('cwd-sentinel');
      expect(result).not.toContain('daemon-sentinel');
    });

    it('uses the registered project when no valid worktree exists', () => {
      const result = blocks(
        makeContext({ worktreePath: path.join(root, 'missing-worktree') }),
        makeGroup({ projectId: 'project-1' }),
      ).join('\n');
      expect(result).toContain('project-sentinel');
      expect(result).not.toContain('worktree-sentinel');
    });

    it('uses the daemon root only for a control group with no configured override', () => {
      expect(
        blocks(makeContext({ isControlGroup: true }), makeGroup()).join('\n'),
      ).toContain('daemon-sentinel');
      expect(blocks(makeContext(), makeGroup()).join('\n')).not.toContain(
        'daemon-sentinel',
      );
      expect(
        blocks(
          makeContext({
            isControlGroup: true,
            worktreePath: path.join(root, 'missing-worktree'),
          }),
          makeGroup(),
        ).join('\n'),
      ).not.toContain('daemon-sentinel');
    });

    it('blocks symlink-shifted registered paths and existing invalid worktrees', () => {
      const shiftedProject = path.join(root, 'shifted-project');
      fs.symlinkSync(projectRoot, shiftedProject, 'dir');
      projects.set('shifted', makeProject('shifted', shiftedProject));
      expect(
        blocks(
          makeContext({ isControlGroup: true }),
          makeGroup({ projectId: 'shifted' }),
        ).join('\n'),
      ).not.toContain('project-sentinel');

      const shiftedWorktree = path.join(root, 'shifted-worktree');
      fs.symlinkSync(worktreeRoot, shiftedWorktree, 'dir');
      expect(
        blocks(
          makeContext({
            isControlGroup: true,
            worktreePath: shiftedWorktree,
          }),
          makeGroup({ projectId: 'project-1' }),
        ).join('\n'),
      ).not.toContain('project-sentinel');
    });

    it('never includes unrelated cwd or workspace roots', () => {
      const unrelated = mkdir('unrelated');
      writeFile(unrelated, 'AGENTS.md', 'unrelated-sentinel');
      const result = blocks(makeContext({ cwd: unrelated }), makeGroup()).join(
        '\n',
      );
      expect(result).not.toContain('unrelated-sentinel');
      expect(result).not.toContain('cwd-sentinel');
    });
  });

  describe('vault isolation and configuration', () => {
    beforeEach(() => {
      writeAll(vaultRoot, 'personal-vault');
    });

    it('never resolves or exposes the literal vault root to a non-control group', () => {
      const resolveVault = vi.fn(() => vaultRoot);
      deps.resolveVault = resolveVault;
      const result = blocks(makeContext()).join('\n');
      expect(result).not.toContain('personal-vault');
      expect(resolveVault).not.toHaveBeenCalled();
    });

    it('loads configured root-level vault files for the control group', () => {
      expect(
        labels(makeContext({ isControlGroup: true }), makeGroup()).filter(
          (label) => label.startsWith('VAULT:'),
        ),
      ).toEqual(FILES.map((file) => `VAULT: ${file}`));
    });

    it('honors explicit opt-out and keeps the missing-key CLAUDE.md default', () => {
      config = { vault_autoload: [] };
      expect(
        labels(makeContext({ isControlGroup: true }), makeGroup()).filter(
          (label) => label.startsWith('VAULT:'),
        ),
      ).toEqual([]);

      config = {};
      expect(
        labels(makeContext({ isControlGroup: true }), makeGroup()).filter(
          (label) => label.startsWith('VAULT:'),
        ),
      ).toEqual(['VAULT: CLAUDE.md']);
    });

    it('excludes files already loaded by D2 and suppresses all direct vault reads when preloaded', () => {
      expect(
        labels(
          makeContext({ isControlGroup: true }),
          makeGroup(),
          makeVaultRecord({ loadedVaultFiles: ['CLAUDE.md'] }),
        ).filter((label) => label.startsWith('VAULT:')),
      ).toEqual(['VAULT: AGENTS.md', 'VAULT: AI_AGENT_GUIDELINES.md']);

      const resolveVault = vi.fn(() => vaultRoot);
      deps.resolveVault = resolveVault;
      expect(
        labels(
          makeContext({ isControlGroup: true }),
          makeGroup(),
          makeVaultRecord({ skipReason: 'already-preloaded' }),
        ).filter((label) => label.startsWith('VAULT:')),
      ).toEqual([]);
      expect(resolveVault).not.toHaveBeenCalled();
    });
  });

  it('uses only validated additional roots and sorts them by logical mount name', () => {
    const rejected = mkdir('rejected-extra');
    writeFile(rejected, 'CLAUDE.md', 'rejected-sentinel');
    writeFile(extraAlpha, 'CLAUDE.md', 'alpha-sentinel');
    writeFile(extraZulu, 'CLAUDE.md', 'zulu-sentinel');
    validatedMounts = [
      {
        hostPath: extraZulu,
        containerPath: '/workspace/extra/zulu',
        readonly: true,
      },
      {
        hostPath: extraAlpha,
        containerPath: '/workspace/extra/alpha',
        readonly: true,
      },
    ];
    const group = makeGroup({
      containerConfig: {
        additionalMounts: [
          { hostPath: rejected },
          { hostPath: extraZulu },
          { hostPath: extraAlpha },
        ],
      },
    });

    const result = loadRegisteredContextFiles(
      makeContext(),
      group,
      makeVaultRecord(),
      deps,
    );
    expect(
      result
        .filter(({ label }) => label.startsWith('EXTRA'))
        .map(({ label }) => label),
    ).toEqual(['EXTRA RULES: alpha/CLAUDE.md', 'EXTRA RULES: zulu/CLAUDE.md']);
    expect(result.map(({ block }) => block).join('\n')).not.toContain(
      'rejected-sentinel',
    );
  });
});
