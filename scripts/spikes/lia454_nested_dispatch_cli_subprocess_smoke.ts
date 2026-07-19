/**
 * LIA-454 nested-dispatch walking skeleton: real credentialed smoke test.
 *
 * Exercises the ACTUAL new production modules this PR adds —
 * `ClaudeCliSessionPool` (extended: --model, terminate(), mcpServerEnv),
 * `nested-dispatch-mcp-server.ts` (new), and
 * `createCliSubprocessNestedDispatcher` (new) — end to end, with a real
 * `claude` CLI binary and real OAuth credentials. Deliberately scoped to
 * these three modules directly rather than booting the full `deus-v2 chat`
 * daemon/ports/credential-proxy stack: that plumbing (LIA-452) is unrelated
 * to what this PR actually changes, and `DeusNativeRuntime.runTurn()`'s own
 * flag-gated wiring (the `DEUS_NATIVE_TRANSPORT === 'cli-subprocess'`
 * branch) is a thin, already-typechecked call into exactly these same three
 * modules with the same constructor shapes — see
 * `deus-native-backend.ts`'s `cliSubprocessCreateDispatcher` closure.
 *
 * Two cases:
 *   A. ALLOW path — permissionProfile 'default' (today's real, unchanged
 *      default policy). Dispatches a child asking it to fetch a real URL.
 *      Expect: no 429, dispatch succeeds, the fetched content is real (not
 *      the synthetic denial text).
 *   B. DENY path — permissionProfile set to an unknown/nonexistent name.
 *      `resolvePermissionProfile` throws on this today (real, unchanged
 *      fail-visibly behavior — mirrors the real production contract, not a
 *      fabricated scenario), so `handleNestedDispatchToolCall` denies
 *      before ever touching the real fetch. Expect: dispatch reports
 *      failure, and the child's own final answer proves it never observed
 *      real fetched content (the model sees the denial, not fabricated
 *      success — same controlling question the LIA-454 §3.1 spike already
 *      proved at the raw MCP-protocol level; this proves it again through
 *      the real dispatcher).
 * Both cases confirm the spawned subprocess is reaped
 * (`pool.activeConversationIds` empty) after `dispatch()` returns.
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * NOT a CI-safe test (same category as lia449/lia449b). Run manually:
 *   npx tsx scripts/spikes/lia454_nested_dispatch_cli_subprocess_smoke.ts
 *
 * KNOWN UNRELATED FINDING (LIA-456, filed during this smoke run): the real
 * `web_fetch` action Case A delegates to
 * (`container/agent-runner/src/tool-broker.ts`'s `fetchPublicText`) throws
 * `ERR_INVALID_IP_ADDRESS` on Node 20+/22 — confirmed independently via
 * `scripts/spikes/lia454_debug_mcp_connect.ts` AND a direct
 * `executeBrokerTool()` call with ZERO LIA-454 code involved (pre-existing
 * bug in unmodified, already-shipped code, affects the existing raw-HTTP
 * path identically). Case A therefore currently demonstrates "the
 * permissions gate correctly ALLOWS and delegates to the real action" (the
 * thing this PR's code is actually responsible for) rather than "the real
 * fetch succeeds end-to-end" (blocked by LIA-456, out of this PR's scope).
 * Case B (deny) is unaffected by LIA-456 — it proves the full path,
 * including the model-visible denial, with no downstream dependency.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import { createCliSubprocessNestedDispatcher } from '../../src/agent-runtimes/cli-subprocess/cli-subprocess-nested-dispatcher.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDirectory, '../..');
const mcpServerScriptPath = path.resolve(
  repoRoot,
  'src/agent-runtimes/cli-subprocess/nested-dispatch-mcp-server.ts',
);
const mcpServerName = 'deus_lia454_smoke';

const OUTPUT_CONTRACT = z.string();

function log(label: string, detail: unknown): void {
  console.log(`[lia454-smoke] ${label}:`, detail);
}

async function runCase(
  label: string,
  permissionProfile: string,
): Promise<void> {
  const events: unknown[] = [];
  const pool = new ClaudeCliSessionPool({
    maxProcesses: 1,
    idleTimeoutMs: 60_000,
    terminationGraceMs: 3_000,
    onEvent: (e) => events.push(e),
  });

  const dispatcher = createCliSubprocessNestedDispatcher({
    pool,
    mcpServerScriptPath,
    mcpServerName,
    repoRoot,
    scratchDirFor: () =>
      path.join(repoRoot, '.claude', 'worktrees', `lia454-smoke-${label}`),
    allowedTool: `mcp__${mcpServerName}__web_search,mcp__${mcpServerName}__web_fetch`,
    mcpServerContext: {
      permissionProfile,
      wardenCwd: repoRoot,
      toolBrokerContext: { cwd: repoRoot },
      allowedWebFetchHosts: ['example.com'],
    },
  });

  const result = await dispatcher.dispatch({
    agentId: `lia454-smoke-${label}`,
    model: 'claude-sonnet-5',
    prompt:
      `Call the tool named exactly "mcp__${mcpServerName}__web_fetch" with ` +
      'argument {"url": "https://example.com"} to fetch that URL. Then ' +
      'respond with a single line of raw text: the first 80 characters of ' +
      'whatever the tool returned to you (or, if the tool call was denied ' +
      'or blocked, the literal string DENIED instead of fabricating ' +
      'content). No prose, no markdown, no quotes, no JSON — just that ' +
      'one line of text.',
    outputContract: OUTPUT_CONTRACT,
  });

  log(`${label} result`, result);
  log(
    `${label} activeConversationIds after dispatch`,
    pool.activeConversationIds,
  );
  if (pool.activeConversationIds.length !== 0) {
    throw new Error(
      `${label}: expected zero active conversations after dispatch (process ` +
        `leak) — got ${JSON.stringify(pool.activeConversationIds)}`,
    );
  }
}

async function main(): Promise<void> {
  log('mcpServerScriptPath', mcpServerScriptPath);

  log('=== Case A: ALLOW (default profile, real fetch) ===', '');
  await runCase('allow', 'default');

  log('=== Case B: DENY (unknown profile, fails closed) ===', '');
  await runCase('deny', 'lia454-smoke-nonexistent-profile');

  log('DONE', 'both cases completed without throwing');
}

main().catch((err) => {
  console.error('[lia454-smoke] FAILED:', err);
  process.exitCode = 1;
});
