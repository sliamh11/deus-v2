/**
 * Independent oracle for the wardens middleware gate wiring.
 *
 * Derived from the ticket contract before any production implementation was
 * present. The oracle observes the documented subprocess boundary through a
 * temporary `python3` executable on PATH; it does not assume which Node child-
 * process API the implementation uses. The fake CLI always exits 0, matching
 * codex_warden_hooks.py's load-bearing contract that allow vs deny is carried
 * by stdout JSON, never by the process exit status.
 *
 * RED before implementation: the current wardens placeholder never invokes
 * codex_warden_hooks.py, always delegates to the tool handler, and records
 * only `allow`. Consequently the block-path non-delegation assertions and the
 * CLI-capture assertions fail for behavioral reasons.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { ToolMessage } from '@langchain/core/messages';
import { createAgent, FakeToolCallingModel, tool } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IS_WINDOWS } from '../platform.js';

import { buildMiddlewareStack } from './middleware-stack.js';

const WORKTREE_ROOT = process.cwd();
const COMMON_GIT_DIR = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: WORKTREE_ROOT, encoding: 'utf8' },
).trim();
const REPO_ROOT = dirname(COMMON_GIT_DIR);
const WARDEN_SCRIPT = join(REPO_ROOT, 'scripts', 'codex_warden_hooks.py');

const PLAN_BEHAVIOR = 'plan-review-gate';
const COMMIT_BEHAVIORS = [
  'code-review-gate',
  'ai-eng-gate',
  'verification-gate',
] as const;

const PATCH_ARGS = {
  patch:
    '*** Begin Patch\n*** Add File: oracle-sentinel\n+blocked\n*** End Patch',
};
const COMMIT_ARGS = {
  command: 'git commit -m "oracle sentinel commit"',
};

interface CapturedInvocation {
  argv: string[];
  event: {
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: unknown;
  };
}

let sandboxDir = '';
let captureDir = '';

// ── Windows fake-`python3` compilation (beforeEach mechanism only) ────────
//
// Production invokes `execFile('python3', [...])` with no `shell: true`
// (middleware-stack.ts:443-446). Node's own child_process docs are explicit
// that without `shell: true`, win32 CreateProcess cannot launch a `.bat`/
// `.cmd` shim — only a genuine PE. The POSIX branch below (untouched) stays
// a `#!/bin/sh` script; on Windows we instead compile a tiny C# console app
// straight to `python3.exe` in the same `binDir`, replicating the POSIX
// shim's argv/stdin capture and conditional block-echo byte-for-byte.
//
// `locateCscExe` is memoized at module scope (not per-test): it only
// resolves *where* the Roslyn compiler lives, which cannot change between
// tests in one process — the compile itself still runs fresh every
// `beforeEach`, per test invocation, from the inline source below.
let cachedCscExePath: string | null | undefined;

function locateCscExe(): string | null {
  if (cachedCscExePath !== undefined) return cachedCscExePath;
  cachedCscExePath = null;

  // Primary: ask vswhere.exe (present on every GitHub windows-2022 runner)
  // where the latest Visual Studio 2022 install lives, then descend into
  // its bundled Roslyn compiler — the same csc.exe MSBuild itself uses.
  try {
    const vswhere = join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    );
    if (existsSync(vswhere)) {
      const installPath = execFileSync(
        vswhere,
        ['-latest', '-products', '*', '-property', 'installationPath'],
        { encoding: 'utf8' },
      ).trim();
      if (installPath) {
        const candidate = join(
          installPath,
          'MSBuild',
          'Current',
          'Bin',
          'Roslyn',
          'csc.exe',
        );
        if (existsSync(candidate)) {
          cachedCscExePath = candidate;
          return cachedCscExePath;
        }
      }
    }
  } catch {
    // vswhere missing or failed — fall through to the standard-path probe.
  }

  // Fallback: the standard VS2022 install roots, for a runner where
  // vswhere itself is absent or found no Roslyn compiler.
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  for (const edition of [
    'Enterprise',
    'Professional',
    'Community',
    'BuildTools',
  ]) {
    const candidate = join(
      programFiles,
      'Microsoft Visual Studio',
      '2022',
      edition,
      'MSBuild',
      'Current',
      'Bin',
      'Roslyn',
      'csc.exe',
    );
    if (existsSync(candidate)) {
      cachedCscExePath = candidate;
      return cachedCscExePath;
    }
  }
  return cachedCscExePath;
}

// C# mirror of the POSIX shim above: capture argv, capture stdin, echo
// WARDEN_ORACLE_BLOCK_JSON to stdout only when the 3rd positional arg
// (args[2] here — args excludes the program name, exactly like the POSIX
// shim's $3 excludes $0) equals WARDEN_ORACLE_BLOCK_BEHAVIOR, always exit 0.
const WINDOWS_STUB_CS_SOURCE = `using System;
using System.IO;

class Program
{
    static int Main(string[] args)
    {
        string captureDir = Environment.GetEnvironmentVariable("WARDEN_ORACLE_CAPTURE_DIR");
        if (string.IsNullOrEmpty(captureDir))
        {
            Console.Error.WriteLine("WARDEN_ORACLE_CAPTURE_DIR: parameter null or not set");
            return 1;
        }
        string behavior = args.Length >= 3 ? args[2] : "missing-behavior";
        string prefix = Path.Combine(captureDir, behavior);

        File.WriteAllText(prefix + ".argv", string.Join("\\n", args) + "\\n");

        using (Stream stdin = Console.OpenStandardInput())
        using (FileStream stdinCapture = File.Create(prefix + ".stdin"))
        {
            stdin.CopyTo(stdinCapture);
        }

        string blockBehavior = Environment.GetEnvironmentVariable("WARDEN_ORACLE_BLOCK_BEHAVIOR") ?? "";
        if (behavior == blockBehavior)
        {
            string blockJson = Environment.GetEnvironmentVariable("WARDEN_ORACLE_BLOCK_JSON");
            if (string.IsNullOrEmpty(blockJson))
            {
                Console.Error.WriteLine("WARDEN_ORACLE_BLOCK_JSON: parameter null or not set");
                return 1;
            }
            Console.Out.Write(blockJson + "\\n");
        }
        return 0;
    }
}
`;

const DOTNET_STUB_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <AssemblyName>python3</AssemblyName>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
`;

/**
 * Compile the C# stub straight to `destPath` (`<binDir>/python3.exe`).
 * Prefers `csc.exe` (fast, no project restore); falls back to `dotnet
 * build` of a minimal throwaway console project when csc.exe cannot be
 * located, per its `<AssemblyName>python3</AssemblyName>` so the apphost
 * lands directly at the expected name.
 */
async function compileWindowsPython3Stub(destPath: string): Promise<void> {
  const binDir = dirname(destPath);
  const csc = locateCscExe();
  if (csc) {
    const sourcePath = join(binDir, 'WardenOraclePython3Stub.cs');
    await writeFile(sourcePath, WINDOWS_STUB_CS_SOURCE, 'utf8');
    execFileSync(csc, ['/nologo', `/out:${destPath}`, sourcePath], {
      stdio: 'pipe',
    });
    return;
  }

  const projectDir = join(binDir, 'warden-oracle-stub');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'stub.csproj'), DOTNET_STUB_CSPROJ, 'utf8');
  await writeFile(
    join(projectDir, 'Program.cs'),
    WINDOWS_STUB_CS_SOURCE,
    'utf8',
  );
  execFileSync('dotnet', ['build', projectDir, '-c', 'Release', '-o', binDir], {
    stdio: 'pipe',
  });
}

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), 'deus-warden-oracle-'));
  const binDir = join(sandboxDir, 'bin');
  captureDir = join(sandboxDir, 'capture');
  await mkdir(binDir);
  await mkdir(captureDir);

  if (IS_WINDOWS) {
    await compileWindowsPython3Stub(join(binDir, 'python3.exe'));
  } else {
    const fakePython = join(binDir, 'python3');
    await writeFile(
      fakePython,
      `#!/bin/sh
set -eu
capture_dir="\${WARDEN_ORACLE_CAPTURE_DIR:?}"
behavior="\${3:-missing-behavior}"
prefix="$capture_dir/$behavior"
printf '%s\\n' "$@" > "$prefix.argv"
cat > "$prefix.stdin"
if [ "$behavior" = "\${WARDEN_ORACLE_BLOCK_BEHAVIOR:-}" ]; then
  printf '%s\\n' "\${WARDEN_ORACLE_BLOCK_JSON:?}"
fi
exit 0
`,
      'utf8',
    );
    await chmod(fakePython, 0o755);
  }

  vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);
  vi.stubEnv('WARDEN_ORACLE_CAPTURE_DIR', captureDir);
  vi.stubEnv('WARDEN_ORACLE_BLOCK_BEHAVIOR', '');
  vi.stubEnv('WARDEN_ORACLE_BLOCK_JSON', '');
}, 60_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandboxDir, { recursive: true, force: true });
});

function scriptedModelCalling(
  toolName: string,
  args: Record<string, unknown>,
): FakeToolCallingModel {
  return new FakeToolCallingModel({
    toolCalls: [[{ name: toolName, args, id: 'warden_oracle_call_1' }], []],
  });
}

async function runToolCall(
  toolName: string,
  args: Record<string, unknown>,
  blockBehavior?: string,
) {
  const handlerSpy = vi.fn(async () => 'ORACLE_TOOL_EXECUTED');
  const spiedTool = tool(handlerSpy, {
    name: toolName,
    description: 'Hermetic tool double for the independent warden oracle.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        patch: { type: 'string' },
        query: { type: 'string' },
      },
      additionalProperties: false,
    },
  });

  let reviseFeedback: string | undefined;
  if (blockBehavior) {
    reviseFeedback = `[${blockBehavior}] REVISE: independent oracle sentinel feedback`;
    vi.stubEnv('WARDEN_ORACLE_BLOCK_BEHAVIOR', blockBehavior);
    vi.stubEnv(
      'WARDEN_ORACLE_BLOCK_JSON',
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reviseFeedback,
        },
      }),
    );
  }

  const { middleware, logs } = buildMiddlewareStack({
    permissions: false,
    memory: false,
    telemetry: false,
  });
  const agent = createAgent({
    model: scriptedModelCalling(toolName, args),
    tools: [spiedTool],
    middleware,
  });
  const result = await agent.invoke({
    messages: [{ role: 'user', content: 'exercise the warden boundary' }],
  });

  const toolMessage = (result as { messages: unknown[] }).messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message as never) &&
      (message as ToolMessage).tool_call_id === 'warden_oracle_call_1',
  );

  return { handlerSpy, logs, reviseFeedback, toolMessage };
}

async function capturedBehaviors(): Promise<string[]> {
  return (await readdir(captureDir))
    .filter((name) => name.endsWith('.stdin'))
    .map((name) => name.slice(0, -'.stdin'.length))
    .sort();
}

async function readInvocation(behavior: string): Promise<CapturedInvocation> {
  const argv = (await readFile(join(captureDir, `${behavior}.argv`), 'utf8'))
    .trimEnd()
    .split('\n');
  const event = JSON.parse(
    await readFile(join(captureDir, `${behavior}.stdin`), 'utf8'),
  ) as CapturedInvocation['event'];
  return { argv, event };
}

async function expectInvocation(
  behavior: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<void> {
  const { argv, event } = await readInvocation(behavior);

  // CLI contract: python3 <script> run <behavior> --repo-root <repo-root> ...
  expect(argv.slice(0, 3)).toEqual([WARDEN_SCRIPT, 'run', behavior]);
  const repoRootFlag = argv.indexOf('--repo-root');
  expect(repoRootFlag).toBeGreaterThanOrEqual(0);
  expect(argv[repoRootFlag + 1]).toBe(REPO_ROOT);

  // Claude Code PreToolUse event contract consumed by all four runners.
  expect(event).toEqual({
    cwd: WORKTREE_ROOT,
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function expectBlockedWithFeedback(
  result: Awaited<ReturnType<typeof runToolCall>>,
  toolName: string,
): void {
  expect(result.handlerSpy).not.toHaveBeenCalled();
  expect(result.toolMessage).toBeDefined();
  expect(result.toolMessage?.status).toBe('error');
  expect(result.toolMessage?.name).toBe(toolName);
  expect(result.reviseFeedback).toBeDefined();
  expect(String(result.toolMessage?.content)).toContain(
    result.reviseFeedback as string,
  );
  expect(result.logs.wardens).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ toolName, decision: 'deny' }),
    ]),
  );
}

describe('@oracle wardens middleware — every real gate can block before tool execution', () => {
  it('@oracle plan-review-gate blocks apply_patch and returns its REVISE reason to the model', async () => {
    // @oracle: plan-review runs at PreToolUse for apply_patch and may deny it.
    const result = await runToolCall('apply_patch', PATCH_ARGS, PLAN_BEHAVIOR);

    expectBlockedWithFeedback(result, 'apply_patch');
    expect(await capturedBehaviors()).toContain(PLAN_BEHAVIOR);
    await expectInvocation(PLAN_BEHAVIOR, 'apply_patch', PATCH_ARGS);
  });

  it.each(COMMIT_BEHAVIORS)(
    '@oracle %s blocks a Bash git-commit call and returns its REVISE reason to the model despite exit code 0',
    async (behavior) => {
      // @oracle: code-review, ai-eng, and verification are independent
      // PreToolUse gates on the Bash commit path; each can deny execution.
      const result = await runToolCall('Bash', COMMIT_ARGS, behavior);

      expectBlockedWithFeedback(result, 'Bash');
      expect(await capturedBehaviors()).toContain(behavior);
      await expectInvocation(behavior, 'Bash', COMMIT_ARGS);
    },
  );
});

describe('@oracle wardens middleware — empty stdout allows the protected action', () => {
  it('@oracle an allowed apply_patch reaches plan-review-gate, then delegates once', async () => {
    // @oracle: allow is represented by empty stdout, not a nonzero/zero code.
    const result = await runToolCall('apply_patch', PATCH_ARGS);

    expect(result.handlerSpy).toHaveBeenCalledTimes(1);
    expect(await capturedBehaviors()).toContain(PLAN_BEHAVIOR);
    expect(result.logs.wardens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'apply_patch',
          decision: 'allow',
        }),
      ]),
    );
    await expectInvocation(PLAN_BEHAVIOR, 'apply_patch', PATCH_ARGS);
  });

  it('@oracle an allowed Bash git commit invokes all three commit gates, then delegates once', async () => {
    // @oracle: the Bash matcher carries code-review, ai-eng, and
    // verification; all three empty outputs are required before execution.
    const result = await runToolCall('Bash', COMMIT_ARGS);

    expect(result.handlerSpy).toHaveBeenCalledTimes(1);
    expect(await capturedBehaviors()).toEqual(
      expect.arrayContaining([...COMMIT_BEHAVIORS]),
    );
    expect(result.logs.wardens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: 'Bash', decision: 'allow' }),
      ]),
    );
    for (const behavior of COMMIT_BEHAVIORS) {
      await expectInvocation(behavior, 'Bash', COMMIT_ARGS);
    }
  });
});

describe('@oracle Claude Code hook path remains installed for additive double enforcement', () => {
  it('@oracle .claude/settings.json still wires the same four behaviors to their PreToolUse matchers', async () => {
    // @oracle: the middleware path is additive; C5 retains Claude's existing
    // plan matcher and Bash commit matcher with their shim commands intact.
    const settings = JSON.parse(
      await readFile(join(WORKTREE_ROOT, '.claude', 'settings.json'), 'utf8'),
    ) as {
      hooks?: {
        PreToolUse?: Array<{
          matcher?: string;
          hooks?: Array<{
            type?: string;
            command?: string;
            timeout?: number;
          }>;
        }>;
      };
    };
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const expectedHook = (behavior: string) => ({
      type: 'command',
      command:
        `bash -c '"\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/` +
        `warden-shim.sh" ${behavior}'`,
      timeout: 5,
    });

    expect(preToolUse).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matcher: 'Write|Edit|MultiEdit|apply_patch|ExitPlanMode',
          hooks: expect.arrayContaining([expectedHook(PLAN_BEHAVIOR)]),
        }),
        expect.objectContaining({
          matcher: 'Bash',
          hooks: expect.arrayContaining(COMMIT_BEHAVIORS.map(expectedHook)),
        }),
      ]),
    );
  });
});
