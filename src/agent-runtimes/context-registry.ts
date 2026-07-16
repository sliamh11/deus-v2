import fs from 'fs';
import path from 'path';

import { readDeusConfig } from '../checks.js';
import { PROJECT_ROOT } from '../config.js';
import { resolveVaultPath } from '../container-mounter.js';
import { getProjectById } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { validateAdditionalMounts } from '../mount-security.js';
import type { ProjectConfig, RegisteredGroup } from '../types.js';
import type { RunContext } from './types.js';
import {
  normalizeVaultAutoload,
  type VaultContextRecord,
} from './vault-context.js';

const REGISTERED_FILENAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  'AI_AGENT_GUIDELINES.md',
] as const;

type RegisteredFilename = (typeof REGISTERED_FILENAMES)[number];
type ContextScope = 'group' | 'global' | 'project' | 'vault' | 'additional';

interface ContextEntry {
  label: string;
  path: string;
  scope: ContextScope;
  skipForControlGroup?: boolean;
  projectOnly?: boolean;
}

export interface RegisteredContextBlock {
  label: string;
  block: string;
}

interface ValidatedAdditionalMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** Injectable filesystem-resolution seams used by the hermetic unit suite. */
export interface ContextRegistryDeps {
  resolveGroupFolder: (folder: string) => string;
  getProject: (id: string) => ProjectConfig | undefined;
  validateMounts: (
    mounts: NonNullable<
      NonNullable<RegisteredGroup['containerConfig']>['additionalMounts']
    >,
    groupName: string,
    isControlGroup: boolean,
  ) => ValidatedAdditionalMount[];
  readConfig: () => Record<string, unknown>;
  resolveVault: (config: Record<string, unknown>) => string | null;
  projectRoot: string;
}

function defaultDeps(): ContextRegistryDeps {
  return {
    resolveGroupFolder: resolveGroupFolderPath,
    getProject: getProjectById,
    validateMounts: validateAdditionalMounts,
    readConfig: readDeusConfig,
    resolveVault: (config) => resolveVaultPath(config),
    projectRoot: PROJECT_ROOT,
  };
}

const DEFAULT_CONTEXT_FILE_MAX_CHARS = 20_000;

function contextFileMaxChars(): number {
  const parsed = Number.parseInt(
    process.env.DEUS_CONTEXT_FILE_MAX_CHARS || '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONTEXT_FILE_MAX_CHARS;
}

function isDirectory(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function readOptionalFile(filePath: string, maxChars: number): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function entriesForRoot(
  scope: ContextScope,
  labelPrefix: string,
  root: string,
  options: Pick<ContextEntry, 'skipForControlGroup' | 'projectOnly'> = {},
  filenameSeparator = ': ',
): ContextEntry[] {
  if (!isDirectory(root)) return [];
  return REGISTERED_FILENAMES.map((filename) => ({
    label: `${labelPrefix}${filenameSeparator}${filename}`,
    path: path.join(root, filename),
    scope,
    ...options,
  }));
}

/**
 * Resolve the host directory that is actually represented by
 * `/workspace/project` in buildVolumeMounts. A configured-but-invalid
 * override never unlocks the control-group daemon-root fallback.
 */
function resolveProjectRoot(
  runContext: RunContext,
  group: RegisteredGroup | undefined,
  deps: ContextRegistryDeps,
): string | undefined {
  const worktreePath = runContext.worktreePath;
  if (worktreePath) {
    let worktreeExists: boolean;
    try {
      worktreeExists = fs.existsSync(worktreePath);
    } catch {
      return undefined;
    }
    if (worktreeExists) {
      try {
        if (!fs.statSync(worktreePath).isDirectory()) return undefined;
        const realWorktree = fs.realpathSync(worktreePath);
        return realWorktree === path.resolve(worktreePath)
          ? realWorktree
          : undefined;
      } catch {
        // An existing-but-uninspectable worktree selected the mount branch;
        // do not fall through to a different, less-restricted host root.
        return undefined;
      }
    }
  }

  if (group?.projectId) {
    let project: ProjectConfig | undefined;
    try {
      project = deps.getProject(group.projectId);
    } catch {
      return undefined;
    }
    if (!project) return undefined;
    try {
      if (!fs.existsSync(project.path)) return undefined;
      if (!fs.statSync(project.path).isDirectory()) return undefined;
      const realProject = fs.realpathSync(project.path);
      return realProject === project.path ? realProject : undefined;
    } catch {
      return undefined;
    }
  }

  if (worktreePath || !runContext.isControlGroup) return undefined;
  return isDirectory(deps.projectRoot) ? deps.projectRoot : undefined;
}

function vaultEntries(
  runContext: RunContext,
  vaultContext: VaultContextRecord,
  deps: ContextRegistryDeps,
): ContextEntry[] {
  // This is a structural boundary, not a label-selection rule: only the
  // control group's container receives the literal vault root.
  if (!runContext.isControlGroup) return [];
  if (vaultContext.skipReason === 'already-preloaded') return [];

  let config: Record<string, unknown>;
  let vaultRoot: string | null;
  try {
    config = deps.readConfig();
    const eligible = new Set<RegisteredFilename>(
      normalizeVaultAutoload(config).filter(
        (filename): filename is RegisteredFilename =>
          (REGISTERED_FILENAMES as readonly string[]).includes(filename),
      ),
    );
    for (const loaded of vaultContext.loadedVaultFiles) {
      eligible.delete(loaded as RegisteredFilename);
    }
    if (eligible.size === 0) return [];

    vaultRoot = deps.resolveVault(config);
    if (vaultRoot === null || !isDirectory(vaultRoot)) return [];

    return entriesForRoot('vault', 'VAULT', vaultRoot).filter((entry) =>
      eligible.has(path.basename(entry.path) as RegisteredFilename),
    );
  } catch {
    return [];
  }
}

function additionalEntries(
  runContext: RunContext,
  group: RegisteredGroup | undefined,
  deps: ContextRegistryDeps,
): ContextEntry[] {
  const mounts = group?.containerConfig?.additionalMounts;
  if (!group || !mounts || mounts.length === 0) return [];

  let validated: ValidatedAdditionalMount[];
  try {
    validated = deps.validateMounts(
      mounts,
      group.name,
      runContext.isControlGroup,
    );
  } catch {
    return [];
  }

  return [...validated]
    .map((mount) => ({
      root: mount.hostPath,
      logicalName: path.relative('/workspace/extra', mount.containerPath),
    }))
    .filter(
      (mount) =>
        mount.logicalName !== '' &&
        mount.logicalName !== '..' &&
        !mount.logicalName.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(mount.logicalName),
    )
    .sort((a, b) =>
      a.logicalName < b.logicalName
        ? -1
        : a.logicalName > b.logicalName
          ? 1
          : 0,
    )
    .flatMap(({ root, logicalName }) =>
      entriesForRoot(
        'additional',
        `EXTRA RULES: ${logicalName}`,
        root,
        {},
        '/',
      ),
    );
}

/**
 * Load the three repository instruction files through host paths equivalent
 * to the container registry's mounted group/global/project/vault/extra roots.
 */
export function loadRegisteredContextFiles(
  runContext: RunContext,
  group: RegisteredGroup | undefined,
  vaultContext: VaultContextRecord,
  deps: ContextRegistryDeps = defaultDeps(),
): RegisteredContextBlock[] {
  let groupRoot: string | undefined;
  try {
    groupRoot = deps.resolveGroupFolder(runContext.groupFolder);
  } catch {
    groupRoot = undefined;
  }

  const entries: ContextEntry[] = [];
  if (groupRoot !== undefined) {
    entries.push(...entriesForRoot('group', 'GROUP RULES', groupRoot));
    entries.push(
      ...entriesForRoot(
        'global',
        'GLOBAL RULES',
        path.join(path.dirname(groupRoot), 'global'),
        { skipForControlGroup: true },
      ),
    );
  }

  const projectRoot = resolveProjectRoot(runContext, group, deps);
  if (projectRoot !== undefined) {
    entries.push(
      ...entriesForRoot('project', 'PROJECT RULES', projectRoot, {
        projectOnly: true,
      }),
    );
  }

  entries.push(...vaultEntries(runContext, vaultContext, deps));
  entries.push(...additionalEntries(runContext, group, deps));

  const maxChars = contextFileMaxChars();
  return entries.flatMap((entry) => {
    if (entry.skipForControlGroup && runContext.isControlGroup) return [];
    if (entry.projectOnly && projectRoot === undefined) return [];
    const content = readOptionalFile(entry.path, maxChars);
    return content
      ? [{ label: entry.label, block: `=== ${entry.label} ===\n${content}` }]
      : [];
  });
}
