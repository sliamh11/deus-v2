/**
 * LIA-454 EP-002 step 7: mcp-tool-gate.ts tests.
 *
 * Same `node:child_process` mocking pattern as `middleware-stack.test.ts`'s
 * own wardens-layer suite (only `execFile` — the Python gate invocation —
 * is faked; `execFileSync` — the real git repo-root query — stays real),
 * so the warden path here exercises the SAME shared `runWardenBehavior`
 * `middleware-stack.ts`'s LangChain path calls, not a re-implementation.
 */
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    execFile: vi.fn(),
  };
});

import { execFile, execFileSync } from 'node:child_process';
import { gateAndExecuteMcpTool, type McpToolResult } from './mcp-tool-gate.js';

const execFileMock = vi.mocked(execFile);

const WORKTREE_ROOT = process.cwd();
const COMMON_GIT_DIR = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: WORKTREE_ROOT, encoding: 'utf8' },
).trim();
const REPO_ROOT = dirname(COMMON_GIT_DIR);

type FakeBehaviorResponse =
  { kind: 'stdout'; stdout: string } | { kind: 'error' };

let behaviorResponses: Map<string, FakeBehaviorResponse>;

function setWardenResponse(behavior: string, response: FakeBehaviorResponse) {
  behaviorResponses.set(behavior, response);
}

beforeEach(() => {
  behaviorResponses = new Map();
  execFileMock.mockReset();
  execFileMock.mockImplementation(((
    _cmd: string,
    args: readonly string[],
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, stdout: string) => void,
  ) => {
    const behavior = args[2] as string;
    const response = behaviorResponses.get(behavior) ?? {
      kind: 'stdout',
      stdout: '',
    };
    const child = {
      stdin: {
        on: () => child.stdin,
        end: () => {
          queueMicrotask(() => {
            if (response.kind === 'error') {
              callback(
                Object.assign(new Error('spawn failed'), { code: 'EFAIL' }),
                '',
              );
              return;
            }
            callback(null, response.stdout);
          });
        },
      },
    };
    return child as unknown as ReturnType<typeof execFile>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
});

afterEach(() => {
  execFileMock.mockReset();
});

const alwaysSucceed = async (): Promise<McpToolResult> => ({
  content: [{ type: 'text', text: 'real action ran' }],
});

describe('gateAndExecuteMcpTool: permissions', () => {
  it('invokes realAction exactly once when the default profile allows the tool', async () => {
    let calls = 0;
    const realAction = async (): Promise<McpToolResult> => {
      calls += 1;
      return alwaysSucceed();
    };
    const result = await gateAndExecuteMcpTool(
      'web_search',
      { query: 'x' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      {},
      realAction,
    );
    expect(calls).toBe(1);
    expect(result.isError).toBeUndefined();
  });

  it('denies before realAction runs when the read-only profile blocks the tool', async () => {
    let realActionCalled = false;
    const result = await gateAndExecuteMcpTool(
      'dispatch_nested_agent',
      {},
      { permissionProfile: 'read-only', wardenCwd: WORKTREE_ROOT },
      {},
      async () => {
        realActionCalled = true;
        return alwaysSucceed();
      },
    );
    expect(realActionCalled).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('permission_denied');
    expect(result.content[0].text).toContain('read-only');
  });

  it('fails closed on an unknown permission profile name, even though the caller never asked to disable enforcement', async () => {
    const result = await gateAndExecuteMcpTool(
      'web_search',
      {},
      { permissionProfile: 'does-not-exist', wardenCwd: WORKTREE_ROOT },
      {},
      alwaysSucceed,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'permission profile resolution failed',
    );
  });

  it('B7 parity: validates an unknown profile name even when permissions:false is set', async () => {
    const result = await gateAndExecuteMcpTool(
      'web_search',
      {},
      { permissionProfile: 'does-not-exist', wardenCwd: WORKTREE_ROOT },
      { permissions: false },
      alwaysSucceed,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'permission profile resolution failed',
    );
  });

  it('permissions:false skips enforcement — a normally-denied tool is allowed through', async () => {
    let calls = 0;
    const result = await gateAndExecuteMcpTool(
      'dispatch_nested_agent',
      {},
      { permissionProfile: 'read-only', wardenCwd: WORKTREE_ROOT },
      { permissions: false },
      async () => {
        calls += 1;
        return alwaysSucceed();
      },
    );
    expect(calls).toBe(1);
    expect(result.isError).toBeUndefined();
  });
});

describe('gateAndExecuteMcpTool: wardens (real shared runWardenBehavior)', () => {
  it('a warden-gated tool call (apply_patch) that the gate allows still runs realAction exactly once', async () => {
    setWardenResponse('plan-review-gate', { kind: 'stdout', stdout: '' }); // empty stdout = allow
    let calls = 0;
    const result = await gateAndExecuteMcpTool(
      'apply_patch',
      { patch: 'diff' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      {},
      async () => {
        calls += 1;
        return alwaysSucceed();
      },
    );
    expect(calls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual([
      join(REPO_ROOT, 'scripts', 'codex_warden_hooks.py'),
      'run',
      'plan-review-gate',
      '--repo-root',
      REPO_ROOT,
    ]);
  });

  it('a real Python-reported deny blocks realAction and returns the raw reason verbatim (not re-wrapped)', async () => {
    setWardenResponse('plan-review-gate', {
      kind: 'stdout',
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: 'REVISE: missing plan-reviewer SHIP',
        },
      }),
    });
    let realActionCalled = false;
    const result = await gateAndExecuteMcpTool(
      'apply_patch',
      { patch: 'diff' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      {},
      async () => {
        realActionCalled = true;
        return alwaysSucceed();
      },
    );
    expect(realActionCalled).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('REVISE: missing plan-reviewer SHIP');
  });

  it('a gate infrastructure failure fails closed with the stable sanitized message, never an allow', async () => {
    setWardenResponse('plan-review-gate', { kind: 'error' });
    let realActionCalled = false;
    const result = await gateAndExecuteMcpTool(
      'apply_patch',
      { patch: 'diff' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      {},
      async () => {
        realActionCalled = true;
        return alwaysSucceed();
      },
    );
    expect(realActionCalled).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('REVISE');
    expect(result.content[0].text).toContain('gate could not be evaluated');
  });

  it('wardens:false skips the check entirely — no execFile call, realAction runs', async () => {
    let calls = 0;
    const result = await gateAndExecuteMcpTool(
      'apply_patch',
      { patch: 'diff' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      { wardens: false },
      async () => {
        calls += 1;
        return alwaysSucceed();
      },
    );
    expect(calls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a non-warden-gated tool (web_search) never invokes execFile at all', async () => {
    const result = await gateAndExecuteMcpTool(
      'web_search',
      { query: 'x' },
      { permissionProfile: 'default', wardenCwd: WORKTREE_ROOT },
      {},
      alwaysSucceed,
    );
    expect(result.isError).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
