import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./middleware-stack.js', async () => {
  const actual = await vi.importActual<typeof import('./middleware-stack.js')>(
    './middleware-stack.js',
  );
  return {
    ...actual,
    probeWardenGateIntegration: vi.fn(),
  };
});

import {
  assessDeusNativeCapabilityReadiness,
  assessDeusNativePipelineReadiness,
  probeDeusNativePipelineReadiness,
  REQUIRED_LINEAR_PIPELINE_TOOLS,
} from './deus-native-pipeline-readiness.js';
import { probeWardenGateIntegration } from './middleware-stack.js';

/**
 * Isolated re-import of the module with `DEUS_NATIVE_SAFE_TOOL_NAMES` mocked
 * to include every required tool, so the static capability checks pass and
 * the dynamic probe path actually gets reached. `vi.resetModules` +
 * dynamic `import()` (rather than a top-level `vi.mock`) keeps this
 * simulated-future-state confined to the one describe block that needs it;
 * every other test in this file exercises the REAL, current
 * `DEUS_NATIVE_SAFE_TOOL_NAMES` (web-only) via the normal top-level import.
 */
async function importWithAllToolsAvailable() {
  vi.resetModules();
  vi.doMock('./tool-broker-langchain-adapter.js', async () => {
    const actual = await vi.importActual<
      typeof import('./tool-broker-langchain-adapter.js')
    >('./tool-broker-langchain-adapter.js');
    return {
      ...actual,
      DEUS_NATIVE_SAFE_TOOL_NAMES: [
        'web_search',
        'web_fetch',
        'read_file',
        'glob_files',
        'grep_files',
        'apply_patch',
        'Bash',
      ],
    };
  });
  vi.doMock('./middleware-stack.js', async () => {
    const actual = await vi.importActual<
      typeof import('./middleware-stack.js')
    >('./middleware-stack.js');
    return { ...actual, probeWardenGateIntegration: vi.fn() };
  });
  const mod = await import('./deus-native-pipeline-readiness.js');
  const middlewareMod = await import('./middleware-stack.js');
  return {
    mod,
    probeWardenGateIntegration: middlewareMod.probeWardenGateIntegration,
  };
}

const ORIGINAL_MIDDLEWARE_CONFIG = process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;

afterEach(() => {
  if (ORIGINAL_MIDDLEWARE_CONFIG === undefined) {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
  } else {
    process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG = ORIGINAL_MIDDLEWARE_CONFIG;
  }
  vi.mocked(probeWardenGateIntegration).mockReset();
});

describe('REQUIRED_LINEAR_PIPELINE_TOOLS', () => {
  it('lists the tools a real Linear coding issue needs', () => {
    expect(REQUIRED_LINEAR_PIPELINE_TOOLS).toEqual([
      'read_file',
      'glob_files',
      'grep_files',
      'apply_patch',
      'Bash',
    ]);
  });
});

describe('assessDeusNativeCapabilityReadiness', () => {
  it('reports every capability failure today (SAFE_TOOL_NAMES is web-only)', () => {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    const result = assessDeusNativeCapabilityReadiness();
    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'workspace_read_unavailable',
        'workspace_mutation_unavailable',
        'commit_execution_unavailable',
      ]),
    );
    expect(result.failures).not.toContain('wardens_disabled');
    // Worktree-independent: never reports workspace_root_unavailable, since
    // this check runs before any worktree attempt.
    expect(result.failures).not.toContain('workspace_root_unavailable');
  });

  it('additionally reports wardens_disabled when the config explicitly disables the layer', () => {
    process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG = JSON.stringify({
      wardens: false,
    });
    const result = assessDeusNativeCapabilityReadiness();
    expect(result.ready).toBe(false);
    expect(result.failures).toContain('wardens_disabled');
  });

  it('does not report wardens_disabled when the config is absent (default enabled)', () => {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    const result = assessDeusNativeCapabilityReadiness();
    expect(result.failures).not.toContain('wardens_disabled');
  });
});

describe('assessDeusNativePipelineReadiness', () => {
  it('adds workspace_root_unavailable on top of capability failures when no worktree exists', () => {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    const result = assessDeusNativePipelineReadiness(undefined);
    expect(result.ready).toBe(false);
    expect(result.failures).toContain('workspace_root_unavailable');
    expect(result.failures).toContain('workspace_mutation_unavailable');
  });

  it('still reports capability failures even when a worktree path IS supplied (today, tools are missing regardless)', () => {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    const result = assessDeusNativePipelineReadiness('/tmp/some-worktree');
    expect(result.ready).toBe(false);
    expect(result.failures).not.toContain('workspace_root_unavailable');
    expect(result.failures).toContain('workspace_mutation_unavailable');
  });
});

describe('probeDeusNativePipelineReadiness', () => {
  it('short-circuits on static failure (real tool surface) without spawning the warden probe subprocess', () => {
    delete process.env.DEUS_NATIVE_MIDDLEWARE_CONFIG;
    const result = probeDeusNativePipelineReadiness(undefined);
    expect(result.ready).toBe(false);
    expect(probeWardenGateIntegration).not.toHaveBeenCalled();
  });

  it('reaches the dynamic probe once static checks pass, and reports warden_runner_unavailable on probe failure', async () => {
    const { mod, probeWardenGateIntegration: mockedProbe } =
      await importWithAllToolsAvailable();
    vi.mocked(mockedProbe).mockReturnValue({
      available: false,
      reason: 'simulated probe failure',
    });
    const result = mod.probeDeusNativePipelineReadiness('/tmp/some-worktree');
    expect(mockedProbe).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ready: false,
      failures: ['warden_runner_unavailable'],
    });
  });

  it('reports ready when static checks pass and the dynamic probe succeeds', async () => {
    const { mod, probeWardenGateIntegration: mockedProbe } =
      await importWithAllToolsAvailable();
    vi.mocked(mockedProbe).mockReturnValue({ available: true });
    const result = mod.probeDeusNativePipelineReadiness('/tmp/some-worktree');
    expect(result).toEqual({ ready: true, failures: [] });
  });
});
