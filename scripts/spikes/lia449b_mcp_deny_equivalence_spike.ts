/**
 * LIA-454 §3.1 verification spike: does an MCP tool result with
 * `isError: true` reach the `claude` CLI subprocess's own internal model
 * loop in a way functionally equivalent to how `middleware-stack.ts`'s
 * `wrapToolCall` denies a call today (returns a LangChain `ToolMessage`
 * with `status: 'error'`, which re-enters the model's ReAct loop without
 * the model treating the call as having succeeded)?
 *
 * This is the exact question `docs/decisions/deus-native-h1-production-wiring-design.md`
 * §3.1 (lines 326-341) flags as UNVERIFIED and calls for "a small
 * LIA-449-style spike" to settle before that design's mechanism is treated
 * as settled. Deliberately narrower than `lia449_cli_subprocess_mcp_walking_skeleton.ts`
 * (already "done", has its own `.results.json`): one conversation, one
 * `sendTurn` call, no multi-conversation cap test, no force-kill/idle-reap
 * phases — those are lia449 proper's job and are irrelevant to this
 * question. New MCP server: `permission-deny-mcp-server.ts` (the LIA-449
 * precedent `permission-check-mcp-server.ts` is a read-only probe that
 * never returns a real MCP error; this spike needed a server that does).
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * NOT a CI-safe test, same category as lia449 (see
 * `permission-deny-mcp-server.test.ts` for the deterministic, CI-safe
 * coverage of the pure handler logic this spike exercises live).
 *
 * Isolation: imports ONLY the new `permission-deny-mcp-server.ts` and the
 * existing, unchanged `cli-subprocess` module. Never touches
 * `deus-native-model.ts`/`deus-native-backend.ts`/the runtime registry.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ClaudeCliSessionPool,
  assertNoAmbiguousAuthOverride,
  type SessionLifecycleEvent,
} from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import {
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
  'src/agent-runtimes/cli-subprocess/permission-deny-mcp-server.ts',
);

export const RESULTS_PATH = path.join(
  spikeDirectory,
  'lia449b_mcp_deny_equivalence_spike.results.json',
);

const MCP_SERVER_NAME = 'deus_lia449b';
const ALLOW_TOOL = `mcp__${MCP_SERVER_NAME}__allow_probe`;
const DENY_TOOL = `mcp__${MCP_SERVER_NAME}__deny_probe`;
const ALLOWED_TOOLS = `${ALLOW_TOOL},${DENY_TOOL}`;

// Word-bounded, same as lia449's own hard-won fix: a bare `/429|rate_limit_error/i`
// false-positives on this run's own random UUIDs (e.g. a fragment like
// "...9e91-429e-b0cd..."). `\b429\b` requires a non-word boundary on both
// sides, which "429e" fails.
const RATE_LIMIT_TEXT_PATTERN = /\b429\b|\brate_limit_error\b/i;

/** Near-duplicate of `lia449_cli_subprocess_mcp_walking_skeleton.ts`'s
 *  `hasRateLimitEvidence` (not exported there, so not importable) — kept
 *  identical rather than reinvented. */
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

// ── Preflight (near-duplicate of lia449's runPreflight — not exported there) ──

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
  denyToolResultText?: string;
  allowToolResultText?: string;
  finalResultText?: string;
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

  console.log('[lia449b] phase 1: preflight');
  const preflight = runPreflight();
  if (!preflight.ok) {
    console.error(
      `[lia449b] preflight FAILED (environmental): ${preflight.failureReason}`,
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
      timingsMs: { totalMs: Date.now() - startedAt },
      zero429: false,
    });
    process.exitCode = 1;
    return;
  }
  console.log(
    `[lia449b] preflight OK: cli=${preflight.cliVersion} authMethod=${preflight.auth?.authMethod} ` +
      `apiProvider=${preflight.auth?.apiProvider}`,
  );

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lia449b-spike-'));
  const pool = new ClaudeCliSessionPool({
    maxProcesses: 1,
    idleTimeoutMs: 120_000,
    terminationGraceMs: 3_000,
    onEvent: (event) => lifecycleEvents.push(event),
  });

  let shutdownStarted = false;
  const gracefulShutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await pool.shutdownAll();
  };
  const syncShutdown = (): void => {
    pool.shutdownAllSync();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    console.log(`[lia449b] received ${signal}, shutting down`);
    void gracefulShutdown().finally(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', syncShutdown);

  const assertions: Record<string, boolean> = {};
  let denyToolResultText: string | undefined;
  let allowToolResultText: string | undefined;
  let finalResultText: string | undefined;

  try {
    // ── Phase 2: start the conversation ────────────────────────────────
    console.log('[lia449b] phase 2: start conversation');
    const spawnStart = Date.now();
    await pool.createConversation('conv-a', {
      scratchDir: path.join(scratchRoot, 'conv-a'),
      mcpServerName: MCP_SERVER_NAME,
      mcpServerScriptPath,
      repoRoot,
      allowedTool: ALLOWED_TOOLS,
    });
    timingsMs.spawnMs = Date.now() - spawnStart;
    console.log('[lia449b] conversation spawned');

    // ── Phase 3: send one turn calling both tools ──────────────────────
    console.log(
      '[lia449b] phase 3: send prompt calling allow_probe + deny_probe',
    );
    const allowProbeId = `lia449b-${randomUUID()}-allow`;
    const denyProbeId = `lia449b-${randomUUID()}-deny`;
    const prompt =
      `Call the allow_probe tool with probeId="${allowProbeId}". Then call ` +
      `the deny_probe tool with probeId="${denyProbeId}". After both calls ` +
      `return, reply with exactly two lines: line 1 must be either ` +
      `"ALLOW_OK" (if the allow_probe call succeeded normally) or ` +
      `"ALLOW_UNEXPECTED" (if anything about it seemed like an error); ` +
      `line 2 must be either "DENY_BLOCKED" (if the deny_probe call ` +
      `reported the action was blocked/not executed) or "DENY_UNEXPECTED" ` +
      `(if you performed the write_file action anyway, or otherwise did ` +
      `not recognize it as blocked). Do not call either tool more than once.`;
    const turnStart = Date.now();
    const turnResult = await pool.sendTurn('conv-a', prompt);
    timingsMs.turnMs = Date.now() - turnStart;

    // ── Phase 4: assertions ─────────────────────────────────────────────
    console.log('[lia449b] phase 4: assert the round-trip');
    const events = turnResult.events;

    const initEvent = events.find(isSystemInitEvent);
    assertions.mcpServerReportedConnected =
      initEvent?.mcp_servers.some(
        (s) => s.name === MCP_SERVER_NAME && s.status === 'connected',
      ) ?? false;

    const assistantEvents = events.filter(isAssistantEvent);
    const toolUseBlocks = assistantEvents.flatMap(extractToolUseBlocks);
    const allowCalls = toolUseBlocks.filter((b) => b.name === ALLOW_TOOL);
    const denyCalls = toolUseBlocks.filter((b) => b.name === DENY_TOOL);
    assertions.assistantCalledAllowProbeExactlyOnce = allowCalls.length === 1;
    // Doubles as the "no retry loop on the denied call" check.
    assertions.assistantCalledDenyProbeExactlyOnce = denyCalls.length === 1;

    const userEvents = events.filter(isUserEvent);
    const toolResultBlocks = userEvents.flatMap(extractToolResultBlocks);

    const allowResultBlock = toolResultBlocks.find((block) => {
      const text = extractToolResultText(block);
      return text.includes(allowProbeId);
    });
    const denyResultBlock = toolResultBlocks.find((block) => {
      const text = extractToolResultText(block);
      return text.includes(denyProbeId);
    });

    allowToolResultText = allowResultBlock
      ? extractToolResultText(allowResultBlock)
      : undefined;
    denyToolResultText = denyResultBlock
      ? extractToolResultText(denyResultBlock)
      : undefined;

    assertions.allowToolResultIsErrorFalseOrAbsent =
      allowResultBlock !== undefined && allowResultBlock.is_error !== true;

    // Controlling assertion #1 — the raw wire-protocol fact.
    assertions.denyToolResultIsErrorTrue =
      denyResultBlock !== undefined && denyResultBlock.is_error === true;

    assertions.denyToolResultTextMatchesMiddlewareStackWording =
      denyToolResultText !== undefined &&
      denyToolResultText.includes(
        'permission_denied: tool "write_file" was blocked by the ' +
          '"read-only" permission profile',
      ) &&
      denyToolResultText.includes(
        'The call was not executed; continue without this tool.',
      );

    finalResultText = turnResult.result.result;
    assertions.terminalResultSuccessful =
      turnResult.result.is_error === false &&
      turnResult.result.subtype === 'success';

    const finalLines = (finalResultText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assertions.modelReportedAllowOk = finalLines.some((line) =>
      /^ALLOW_OK$/.test(line),
    );
    // Controlling assertion #2 — the behavioral fact: did the model
    // understand the call was blocked, rather than fabricating success?
    assertions.modelReportedDenyBlocked = finalLines.some((line) =>
      /^DENY_BLOCKED$/.test(line),
    );

    const stderrTail = pool.getStderrTail('conv-a');
    assertions.zeroRateLimitEvidence = !hasRateLimitEvidence(
      events,
      stderrTail,
    );

    for (const key of [
      'mcpServerReportedConnected',
      'assistantCalledAllowProbeExactlyOnce',
      'assistantCalledDenyProbeExactlyOnce',
      'allowToolResultIsErrorFalseOrAbsent',
      'denyToolResultIsErrorTrue',
      'denyToolResultTextMatchesMiddlewareStackWording',
      'terminalResultSuccessful',
      'modelReportedAllowOk',
      'modelReportedDenyBlocked',
      'zeroRateLimitEvidence',
    ]) {
      console.log(`[lia449b]   ${key}: ${assertions[key] ? 'PASS' : 'FAIL'}`);
    }

    if (
      assertions.denyToolResultIsErrorTrue &&
      !assertions.modelReportedDenyBlocked
    ) {
      console.warn(
        '[lia449b] SPLIT RESULT: wire-level isError:true reached the CLI, ' +
          'but the model did not report DENY_BLOCKED — report this split ' +
          'back into the design doc, not just a bare FAIL.',
      );
    } else if (
      !assertions.denyToolResultIsErrorTrue &&
      assertions.modelReportedDenyBlocked
    ) {
      console.warn(
        '[lia449b] SPLIT RESULT: the model reported DENY_BLOCKED, but the ' +
          'events stream never showed is_error:true on the matching tool ' +
          'result — report this split back into the design doc.',
      );
    }
  } finally {
    console.log('[lia449b] phase 5: shutdownAll + scratch cleanup');
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    process.off('exit', syncShutdown);
    await gracefulShutdown();
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  timingsMs.totalMs = Date.now() - startedAt;

  const artifact: SmokeResultArtifact = {
    generatedAt: new Date().toISOString(),
    cliVersion: preflight.cliVersion,
    authMethod: preflight.auth?.authMethod,
    apiProvider: preflight.auth?.apiProvider,
    subscriptionType: preflight.auth?.subscriptionType,
    assertions,
    lifecycleEventSequence: lifecycleEvents.map(redactLifecycleEvent),
    denyToolResultText,
    allowToolResultText,
    finalResultText,
    timingsMs,
    zero429: assertions.zeroRateLimitEvidence ?? false,
  };
  writeResult(artifact);

  const overall = allPassed(assertions);
  console.log(`\n[lia449b] OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  if (!overall) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[lia449b] spike crashed:', errorMessage(error));
    process.exitCode = 1;
  });
}
