/**
 * LIA-449 walking skeleton: credentialed smoke run for the native Claude CLI
 * subprocess + stdio MCP transport (`src/agent-runtimes/cli-subprocess/`).
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * this is NOT a CI-safe test (see `ClaudeCliSessionPool`'s unit tests for the
 * deterministic, fake-process-driven coverage). Follows the executable-spike
 * / live-run-evidence pattern established by
 * `lia400_tool_loop_reliability_benchmark.ts` rather than an
 * `*.integration.test.ts` (see `docs/decisions/deus-native-cli-subprocess-mcp-seam.md`).
 *
 * Phases:
 *   1. Preflight native CLI version + OAuth status (no secrets read/logged).
 *   2. Start conversation A, record its PID.
 *   3. While A is alive, attempt conversation B and assert cap rejection.
 *   4. Send A's one real prompt requiring the custom MCP tool.
 *   5. Assert the full round-trip (MCP connected, tool called with the right
 *      args, tool result matches, terminal result reflects it, PID stable,
 *      zero 429s).
 *   6. Force-kill A externally; assert the pool classifies/surfaces an
 *      unexpected exit and both the CLI and MCP server PIDs are gone.
 *   7. Start an idle-only conversation with a short idle timeout; assert
 *      idle_reaped + exited + PID gone.
 *   8. `finally`: shutdownAll() every pool, remove the scratch directory.
 *
 * Isolation: imports ONLY the new `cli-subprocess` module and `platform.ts`
 * (an existing, already-shared utility). Never touches
 * `deus-native-model.ts`/`deus-native-backend.ts`/the runtime registry.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processExists, forceKillProcessGroup } from '../../src/platform.js';
import {
  ClaudeCliSessionPool,
  assertNoAmbiguousAuthOverride,
  type SessionLifecycleEvent,
} from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import {
  extractAssistantText,
  extractToolResultBlocks,
  extractToolResultText,
  extractToolUseBlocks,
  isAssistantEvent,
  isSystemInitEvent,
  isUserEvent,
  type StreamJsonEvent,
} from '../../src/agent-runtimes/cli-subprocess/stream-json-protocol.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDirectory, '../..');
const mcpServerScriptPath = path.resolve(
  repoRoot,
  'src/agent-runtimes/cli-subprocess/permission-check-mcp-server.ts',
);

export const RESULTS_PATH = path.join(
  spikeDirectory,
  'lia449_cli_subprocess_mcp_walking_skeleton.results.json',
);

const MCP_SERVER_NAME = 'deus_lia449';
const ALLOWED_TOOL = `mcp__${MCP_SERVER_NAME}__check_permission`;
// Word-bounded: a bare `/429|rate_limit_error/i` false-positived on this very
// smoke run's own random UUIDs (e.g. a `uuid` field containing "...9e91-
// 429e-b0cd...", a coincidental hex fragment, not an HTTP 429) — verified
// live, not assumed. `\b429\b` requires a non-word boundary on both sides,
// which "429e" fails (no boundary between the digit and the following "e").
const RATE_LIMIT_TEXT_PATTERN = /\b429\b|\brate_limit_error\b/i;

/** Structured check first (the CLI's own `rate_limit_event.rate_limit_info
 *  .status` field, verified live to read `"allowed"` on an unthrottled run),
 *  then the word-bounded text scan as a fallback net — restricted to
 *  `stderrTail` (genuine raw diagnostic text) only, NEVER the serialized
 *  `events` array. Scanning the full JSON-stringified conversation history
 *  false-positives on any ordinary numeric field that happens to equal 429
 *  (a token count, a duration_ms, an exit code, ...) even when
 *  `rate_limit_info.status` reads "allowed" — the structured check already
 *  covers the CLI's own real rate-limit shape; the text fallback exists for
 *  a raw error string appearing somewhere the structured shape doesn't
 *  cover, which stderr is, and an arbitrary structured event field is not. */
function hasRateLimitEvidence(
  events: StreamJsonEvent[],
  stderrTail: string,
): boolean {
  const structuralHit = events.some((event) => {
    if (event.type !== 'rate_limit_event') return false;
    const info = event['rate_limit_info'] as
      Record<string, unknown> | undefined;
    return info !== undefined && info['status'] !== 'allowed';
  });
  if (structuralHit) return true;
  return RATE_LIMIT_TEXT_PATTERN.test(stderrTail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Redacted lifecycle event log ─────

interface RedactedLifecycleEvent {
  type: SessionLifecycleEvent['type'];
  conversationId?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function redactLifecycleEvent(
  event: SessionLifecycleEvent,
): RedactedLifecycleEvent {
  return {
    type: event.type,
    conversationId: event.conversationId,
    exitCode: event.exitCode,
    signal: event.signal,
  };
}

// ── Preflight (phase 1) ──────────────────────────────────────────────────

interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

interface PreflightResult {
  ok: boolean;
  cliVersion?: string;
  auth?: AuthStatus;
  failureReason?: string;
}

/** Retains ONLY non-secret fields needed to establish the auth method
 *: never `email`, `orgId`, `orgName`, or any
 *  credential/token material. */
function redactAuthStatus(raw: unknown): AuthStatus {
  const record = raw as Record<string, unknown>;
  return {
    loggedIn: record['loggedIn'] === true,
    authMethod:
      typeof record['authMethod'] === 'string'
        ? record['authMethod']
        : undefined,
    apiProvider:
      typeof record['apiProvider'] === 'string'
        ? record['apiProvider']
        : undefined,
    subscriptionType:
      typeof record['subscriptionType'] === 'string'
        ? record['subscriptionType']
        : undefined,
  };
}

function runPreflight(): PreflightResult {
  try {
    assertNoAmbiguousAuthOverride(process.env);
  } catch (error) {
    return { ok: false, failureReason: errorMessage(error) };
  }

  let cliVersion: string;
  try {
    cliVersion = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return {
      ok: false,
      failureReason: `native \`claude\` CLI not runnable on PATH: ${errorMessage(error)}`,
    };
  }

  let auth: AuthStatus;
  try {
    const raw = execFileSync('claude', ['auth', 'status', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDECODE: '', NODE_OPTIONS: '' },
    });
    auth = redactAuthStatus(JSON.parse(raw));
  } catch (error) {
    return {
      ok: false,
      cliVersion,
      failureReason: `\`claude auth status --json\` failed: ${errorMessage(error)}`,
    };
  }

  if (!auth.loggedIn) {
    return {
      ok: false,
      cliVersion,
      auth,
      failureReason: 'claude auth status reports not logged in',
    };
  }

  return { ok: true, cliVersion, auth };
}

// ── Polling helper (real wall-clock waits -- this is the live smoke run) ──

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollIntervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

// ── Result artifact ──────────────────────────────────────────────────────

interface SmokeResultArtifact {
  generatedAt: string;
  cliVersion?: string;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  environmentalFailure?: string;
  assertions: Record<string, boolean>;
  lifecycleEventSequence: RedactedLifecycleEvent[];
  toolName?: string;
  decision?: string;
  source?: string;
  finalResultText?: string;
  exitReasons: Record<
    string,
    { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
  >;
  timingsMs: Record<string, number>;
  zero429: boolean;
}

function writeResult(artifact: SmokeResultArtifact): void {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

function allPassed(assertions: Record<string, boolean>): boolean {
  return Object.values(assertions).every((v) => v === true);
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const startedAt = Date.now();
  const lifecycleEvents: SessionLifecycleEvent[] = [];
  const timingsMs: Record<string, number> = {};

  console.log('[lia449] phase 1: preflight');
  const preflight = runPreflight();
  if (!preflight.ok) {
    console.error(
      `[lia449] preflight FAILED (environmental): ${preflight.failureReason}`,
    );
    writeResult({
      generatedAt: new Date().toISOString(),
      cliVersion: preflight.cliVersion,
      authMethod: preflight.auth?.authMethod,
      apiProvider: preflight.auth?.apiProvider,
      subscriptionType: preflight.auth?.subscriptionType,
      environmentalFailure: preflight.failureReason,
      assertions: {},
      lifecycleEventSequence: [],
      exitReasons: {},
      timingsMs: { totalMs: Date.now() - startedAt },
      zero429: false,
    });
    process.exitCode = 1;
    return;
  }
  console.log(
    `[lia449] preflight OK: cli=${preflight.cliVersion} authMethod=${preflight.auth?.authMethod} ` +
      `apiProvider=${preflight.auth?.apiProvider}`,
  );

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lia449-smoke-'));
  // Longer-idle pool for the interactive conversations (A, B); a SEPARATE
  // short-idle pool for phase 7's idle-only conversation, so the main
  // pool's idle timer never races the real API latency of phases 2-6.
  const mainPool = new ClaudeCliSessionPool({
    maxProcesses: 1,
    idleTimeoutMs: 120_000,
    terminationGraceMs: 3_000,
    onEvent: (event) => lifecycleEvents.push(event),
  });
  const idlePool = new ClaudeCliSessionPool({
    maxProcesses: 1,
    idleTimeoutMs: 3_000,
    terminationGraceMs: 1_000,
    onEvent: (event) => lifecycleEvents.push(event),
  });

  let shutdownStarted = false;
  const gracefulShutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await Promise.all([mainPool.shutdownAll(), idlePool.shutdownAll()]);
  };
  const syncShutdown = (): void => {
    mainPool.shutdownAllSync();
    idlePool.shutdownAllSync();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    console.log(`[lia449] received ${signal}, shutting down`);
    void gracefulShutdown().finally(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', syncShutdown);

  const assertions: Record<string, boolean> = {};
  let toolName: string | undefined;
  let decision: string | undefined;
  let source: string | undefined;
  let finalResultText: string | undefined;

  try {
    // ── Phase 2: start conversation A ─────────────────────────────────
    console.log('[lia449] phase 2: start conversation A');
    const spawnStart = Date.now();
    const handleA = await mainPool.createConversation('conv-a', {
      scratchDir: path.join(scratchRoot, 'conv-a'),
      mcpServerName: MCP_SERVER_NAME,
      mcpServerScriptPath,
      repoRoot,
      allowedTool: ALLOWED_TOOL,
    });
    timingsMs.spawnMs = Date.now() - spawnStart;
    console.log(`[lia449] conversation A spawned (pid recorded internally)`);

    // ── Phase 3: cap rejection ─────────────────────────────────────────
    console.log(
      '[lia449] phase 3: attempt conversation B, expect cap rejection',
    );
    let capRejected = false;
    try {
      await mainPool.createConversation('conv-b', {
        scratchDir: path.join(scratchRoot, 'conv-b'),
        mcpServerName: MCP_SERVER_NAME,
        mcpServerScriptPath,
        repoRoot,
        allowedTool: ALLOWED_TOOL,
      });
    } catch {
      capRejected = true;
    }
    assertions.capRejectionThrew = capRejected;
    assertions.capRejectionEventEmitted = lifecycleEvents.some(
      (e) => e.type === 'concurrency_rejected' && e.conversationId === 'conv-b',
    );

    // ── Phase 4: send A's real prompt ──────────────────────────────────
    console.log('[lia449] phase 4: send real prompt requiring the MCP tool');
    const probeId = `lia449-${randomUUID()}`;
    const prompt =
      `Call the check_permission tool with toolName="write_file" and ` +
      `probeId="${probeId}". Then reply with just the word ok.`;
    const turnStart = Date.now();
    const turnResult = await mainPool.sendTurn('conv-a', prompt);
    timingsMs.turnMs = Date.now() - turnStart;
    const pidDuringTurn = turnResult.pid;
    const pidAfterTurn = mainPool.getPid('conv-a');

    // ── Phase 5: assertions ─────────────────────────────────────────────
    console.log('[lia449] phase 5: assert the round-trip');
    const events = turnResult.events;

    const initEvent = events.find(isSystemInitEvent);
    assertions.mcpServerReportedConnected =
      initEvent?.mcp_servers.some(
        (s) => s.name === MCP_SERVER_NAME && s.status === 'connected',
      ) ?? false;

    const assistantEvents = events.filter(isAssistantEvent);
    const toolUseBlocks = assistantEvents.flatMap(extractToolUseBlocks);
    const checkPermissionCalls = toolUseBlocks.filter(
      (b) => b.name === ALLOWED_TOOL,
    );
    assertions.assistantCalledExactlyOneCheckPermission =
      checkPermissionCalls.length === 1;
    toolName = checkPermissionCalls[0]?.name;

    const callInput = checkPermissionCalls[0]?.input as
      { toolName?: string; probeId?: string } | undefined;
    assertions.toolCallInputMatchesProbeAndToolName =
      callInput?.probeId === probeId && callInput?.toolName === 'write_file';

    const userEvents = events.filter(isUserEvent);
    const toolResultBlocks = userEvents.flatMap(extractToolResultBlocks);
    const matchingResult = toolResultBlocks
      .map((block) => {
        try {
          return JSON.parse(extractToolResultText(block)) as Record<
            string,
            unknown
          >;
        } catch {
          return undefined;
        }
      })
      .find((parsed) => parsed?.['probeId'] === probeId);
    decision =
      typeof matchingResult?.['decision'] === 'string'
        ? (matchingResult['decision'] as string)
        : undefined;
    source =
      typeof matchingResult?.['source'] === 'string'
        ? (matchingResult['source'] as string)
        : undefined;
    assertions.toolResultMatchesProbeDenyRule =
      matchingResult !== undefined && decision === 'deny' && source === 'rule';

    finalResultText = turnResult.result.result;
    assertions.terminalResultSuccessful =
      turnResult.result.is_error === false &&
      turnResult.result.subtype === 'success';
    assertions.terminalResultReflectsToolOutcome =
      typeof finalResultText === 'string' && /\bok\b/i.test(finalResultText);

    assertions.pidStableAcrossTurn =
      handleA.pid === pidDuringTurn && pidDuringTurn === pidAfterTurn;

    const stderrTail = mainPool.getStderrTail('conv-a');
    assertions.zeroRateLimitEvidence = !hasRateLimitEvidence(
      events,
      stderrTail,
    );

    for (const key of [
      'mcpServerReportedConnected',
      'assistantCalledExactlyOneCheckPermission',
      'toolCallInputMatchesProbeAndToolName',
      'toolResultMatchesProbeDenyRule',
      'terminalResultSuccessful',
      'terminalResultReflectsToolOutcome',
      'pidStableAcrossTurn',
      'zeroRateLimitEvidence',
    ]) {
      console.log(`[lia449]   ${key}: ${assertions[key] ? 'PASS' : 'FAIL'}`);
    }

    // ── Phase 6: external force-kill + crash surfacing ─────────────────
    console.log('[lia449] phase 6: external force-kill of conversation A');
    const mcpServerPid =
      typeof matchingResult?.['pid'] === 'number'
        ? (matchingResult['pid'] as number)
        : undefined;
    const cliPid = handleA.pid;
    forceKillProcessGroup(cliPid);
    const observedCrash = await waitUntil(
      () =>
        lifecycleEvents.some(
          (e) => e.type === 'exited' && e.conversationId === 'conv-a',
        ),
      10_000,
    );
    assertions.unexpectedExitSurfaced = lifecycleEvents.some(
      (e) => e.type === 'unexpected_exit' && e.conversationId === 'conv-a',
    );
    assertions.exitedEventEmittedAfterForceKill = observedCrash;
    // Give the OS a brief moment to finish reaping the process-group targets.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertions.cliProcessGone = !processExists(cliPid);
    assertions.mcpServerProcessGone =
      mcpServerPid === undefined ? false : !processExists(mcpServerPid);

    // ── Phase 7: idle-only conversation, short idle timeout ────────────
    console.log('[lia449] phase 7: idle-only conversation, expect idle_reaped');
    const handleIdle = await idlePool.createConversation('conv-idle', {
      scratchDir: path.join(scratchRoot, 'conv-idle'),
      mcpServerName: MCP_SERVER_NAME,
      mcpServerScriptPath,
      repoRoot,
      allowedTool: ALLOWED_TOOL,
    });
    const idleReaped = await waitUntil(
      () =>
        lifecycleEvents.some(
          (e) => e.type === 'idle_reaped' && e.conversationId === 'conv-idle',
        ),
      10_000,
    );
    const idleExited = await waitUntil(
      () =>
        lifecycleEvents.some(
          (e) => e.type === 'exited' && e.conversationId === 'conv-idle',
        ),
      10_000,
    );
    assertions.idleReapedEventEmitted = idleReaped;
    assertions.idleExitedEventEmitted = idleExited;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertions.idleConversationProcessGone = !processExists(handleIdle.pid);
  } finally {
    // ── Phase 8: cleanup ────────────────────────────────────────────────
    console.log('[lia449] phase 8: shutdownAll + scratch cleanup');
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('exit', syncShutdown);
    await gracefulShutdown();
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  timingsMs.totalMs = Date.now() - startedAt;
  const exitReasons: SmokeResultArtifact['exitReasons'] = {};
  for (const event of lifecycleEvents) {
    if (event.type === 'exited' && event.conversationId !== undefined) {
      exitReasons[event.conversationId] = {
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      };
    }
  }

  const artifact: SmokeResultArtifact = {
    generatedAt: new Date().toISOString(),
    cliVersion: preflight.cliVersion,
    authMethod: preflight.auth?.authMethod,
    apiProvider: preflight.auth?.apiProvider,
    subscriptionType: preflight.auth?.subscriptionType,
    assertions,
    lifecycleEventSequence: lifecycleEvents.map(redactLifecycleEvent),
    toolName,
    decision,
    source,
    finalResultText,
    exitReasons,
    timingsMs,
    zero429: assertions.zeroRateLimitEvidence ?? false,
  };
  writeResult(artifact);

  const overall = allPassed(assertions);
  console.log(`\n[lia449] OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  if (!overall) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[lia449] smoke run crashed:', errorMessage(error));
    process.exitCode = 1;
  });
}
