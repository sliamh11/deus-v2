/**
 * Explicit native pipeline-readiness contract (LIA-422/E3).
 *
 * The Linear pipeline dispatcher's `runIssue`/`executeAgentRun` path always
 * ends with "implement the plan, commit what is done" — real coding-and-
 * commit work. Today the `deus-native` tool surface
 * (`DEUS_NATIVE_SAFE_TOOL_NAMES` in tool-broker-langchain-adapter.ts) exposes
 * only `web_search`/`web_fetch`: no `apply_patch`, no commit-capable `Bash`.
 * Selecting `deus-native` as the pipeline backend today would therefore
 * dispatch a real Linear issue to an agent that CANNOT implement or commit
 * anything — a silent no-op that could still emit `agent_started`/
 * `agent_completed` and advance the issue, misreporting success.
 *
 * This module answers, before any such dispatch, whether the native runtime
 * genuinely has what a Linear pipeline issue needs. Three layers, each a
 * strict superset of the one before: `assessDeusNativeCapabilityReadiness`
 * (worktree-independent tool/wardens facts — the dispatcher's pre-worktree
 * fast-fail gate), `assessDeusNativePipelineReadiness` (adds the
 * worktree-presence check, meaningful only after a worktree attempt has
 * happened), and `probeDeusNativePipelineReadiness` (adds the one dynamic
 * check: whether the warden gate script itself can load). See
 * `docs/decisions/linear-pipeline-deus-native-capability-boundary.md` for
 * the accepted scope this contract implements.
 *
 * Fail-closed by construction: every check defaults to "missing" unless
 * explicitly proven present. Confirmed available: `resolveMiddlewareStackConfig()`
 * matches production's own config-resolution path (LIA-422 plan review,
 * mirrors deus-native-backend.ts's own call), and NOT a mocked config
 * (regression risk called out for review: import from resolve.js and pin an
 * import-source oracle if this ever needs to be faked in a test — the
 * existing tests inject config directly instead).
 */

import { DEUS_NATIVE_SAFE_TOOL_NAMES } from './tool-broker-langchain-adapter.js';
import {
  probeWardenGateIntegration,
  resolveMiddlewareStackConfig,
} from './middleware-stack.js';

/** The tool-broker names a Linear pipeline coding issue genuinely needs.
 *  Not a subset of `DEUS_NATIVE_SAFE_TOOL_NAMES` today — that IS the gap
 *  this contract exists to detect. */
export const REQUIRED_LINEAR_PIPELINE_TOOLS = [
  'read_file',
  'glob_files',
  'grep_files',
  'apply_patch',
  'Bash',
] as const;

export type PipelineReadinessFailureCode =
  | 'workspace_read_unavailable'
  | 'workspace_mutation_unavailable'
  | 'commit_execution_unavailable'
  | 'wardens_disabled'
  | 'warden_runner_unavailable'
  | 'workspace_root_unavailable';

export interface PipelineReadiness {
  ready: boolean;
  failures: PipelineReadinessFailureCode[];
}

const WORKSPACE_READ_TOOLS = ['read_file', 'glob_files', 'grep_files'] as const;

function hasTool(name: string): boolean {
  return (DEUS_NATIVE_SAFE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Worktree-INDEPENDENT capability check: tool surface + wardens config only.
 * No subprocess spawn, safe to run before creating an issue worktree or
 * consuming a dispatch queue slot — this is the fast-fail gate the
 * dispatcher runs first, for every candidate issue, regardless of whether a
 * worktree exists yet. Deliberately excludes `workspace_root_unavailable`:
 * that dimension depends on a per-issue worktree that doesn't exist at this
 * point by design, so bundling it here would permanently refuse dispatch
 * even after a future ticket widens the tool surface (this check would
 * still run before any worktree is created).
 */
export function assessDeusNativeCapabilityReadiness(): PipelineReadiness {
  const failures: PipelineReadinessFailureCode[] = [];

  if (!WORKSPACE_READ_TOOLS.every(hasTool)) {
    failures.push('workspace_read_unavailable');
  }
  if (!hasTool('apply_patch')) {
    failures.push('workspace_mutation_unavailable');
  }
  if (!hasTool('Bash')) {
    failures.push('commit_execution_unavailable');
  }
  if (resolveMiddlewareStackConfig().wardens === false) {
    failures.push('wardens_disabled');
  }

  return { ready: failures.length === 0, failures };
}

/**
 * Full readiness: the worktree-independent capability checks above, plus
 * the worktree-presence check. Only meaningful to call once a worktree
 * creation attempt has actually happened (i.e. after
 * `assessDeusNativeCapabilityReadiness()` already passed and the dispatcher
 * has tried `ensureIssueWorktree()`) — calling this beforehand would always
 * report `workspace_root_unavailable` regardless of capability state.
 */
export function assessDeusNativePipelineReadiness(
  worktreePath: string | undefined,
): PipelineReadiness {
  const capability = assessDeusNativeCapabilityReadiness();
  const failures = [...capability.failures];
  if (worktreePath === undefined) {
    failures.push('workspace_root_unavailable');
  }
  return { ready: failures.length === 0, failures };
}

/**
 * Full readiness, plus the one dynamic check (`probeWardenGateIntegration`)
 * that confirms the warden gate script can actually load. Callers on a hot
 * poll loop should prefer the static checks above for the fast-fail path and
 * only reach this once those already pass, to avoid a subprocess spawn per
 * candidate issue when static checks alone already refuse — today, they
 * always do (no candidate ever has `apply_patch`/`Bash`), so this probe
 * never actually runs in production until the dependent tool-widening
 * ticket lands.
 */
export function probeDeusNativePipelineReadiness(
  worktreePath: string | undefined,
): PipelineReadiness {
  const staticResult = assessDeusNativePipelineReadiness(worktreePath);
  if (!staticResult.ready) return staticResult;

  const wardenCwd = worktreePath ?? process.cwd();
  const probe = probeWardenGateIntegration(wardenCwd);
  if (!probe.available) {
    return { ready: false, failures: ['warden_runner_unavailable'] };
  }
  return { ready: true, failures: [] };
}
