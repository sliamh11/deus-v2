/**
 * LIA-454 EP-002 step 12: real credentialed smoke test for the PARENT turn
 * loop through the CLI-subprocess transport (steps 9-11). Unlike the
 * nested-dispatch-only smoke (`lia454_nested_dispatch_cli_subprocess_smoke.ts`,
 * PR #47), this exercises `runParentTurnViaCliSubprocess` directly — the
 * actual module `DeusNativeRuntime.runTurn()`'s CLI branch calls — with a
 * real `claude` CLI binary, real OAuth credentials, and a real (temp-file)
 * `SqliteSaver`.
 *
 * Per EP-002's Goal section (as reconciled at step 11 plan-review): "zero
 * 429s across multi-turn conversation (with a real cross-turn recall
 * assertion) + nested dispatch + a permission denial" — NOT full compaction
 * or memory-recall parity (LIA-457/LIA-458, explicitly deferred). Four
 * cases:
 *
 *   A. Multi-turn conversation with cross-turn recall. Turn 1 states a fact
 *      under a unique, made-up reference token. Turn 2, same thread, asks
 *      about that token with NO other context. This is the actual oracle
 *      for step 11's history-injection fix (the severe bug where step 10's
 *      runner read prior checkpoint messages but never sent them to the
 *      CLI at all) — a unit test can prove a history file is WRITTEN, but
 *      only a real model call proves the CLI actually READS and USES it.
 *   B. Nested dispatch. The parent is asked to dispatch the real
 *      'researcher' role (the one production-allowlisted catalog id) via
 *      `dispatch_nested_agent`, proving the parent's full 3-tool MCP
 *      catalog (not just the 2-tool nested-dispatch-child catalog) works
 *      end-to-end through this transport.
 *   C. Permission denial. `permissionProfile: 'read-only'` denies
 *      `dispatch_nested_agent` before any child-process construction (unit-
 *      tested already in `parent-turn-mcp-server.test.ts`) — this proves it
 *      through a REAL model call: the model must observe the denial text,
 *      never fabricate a fake success.
 *   D. Checkpoint durability. After case A, independently re-open the same
 *      temp SqliteSaver file fresh (not the in-memory instance this script
 *      already holds) and confirm both turns' messages are really there —
 *      proving genuine persistence, not just an in-process return value.
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * NOT a CI-safe test (same category as lia449/lia449b/the nested-dispatch
 * smoke above). Run manually:
 *   npx tsx scripts/spikes/lia454_parent_turn_cli_subprocess_smoke.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import { runParentTurnViaCliSubprocess } from '../../src/agent-runtimes/cli-subprocess/parent-turn-runner.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDirectory, '../..');
const mcpServerScriptPath = path.resolve(
  repoRoot,
  'src/agent-runtimes/cli-subprocess/parent-turn-mcp-server.ts',
);
const mcpServerName = 'deus_lia454_parent_smoke';

function log(label: string, detail: unknown): void {
  console.log(`[lia454-parent-smoke] ${label}:`, detail);
}

/** Finds the ToolMessage content for the first `dispatch_nested_agent` tool
 *  call in a turn's translated messages — the actual MCP tool-result text,
 *  which is what proves allow-vs-deny (the model's OWN final prose is not a
 *  reliable oracle for this — always inspect the tool result directly). */
function findDispatchToolResultContent(
  messages: readonly unknown[],
): string | undefined {
  const toolCallIds = new Set<string>();
  for (const m of messages) {
    const calls = (m as { tool_calls?: Array<{ id?: string; name?: string }> })
      .tool_calls;
    if (Array.isArray(calls)) {
      for (const c of calls) {
        if (c.name === 'dispatch_nested_agent' && c.id !== undefined) {
          toolCallIds.add(c.id);
        }
      }
    }
  }
  for (const m of messages) {
    const toolMsg = m as { tool_call_id?: string; content?: unknown };
    if (
      toolMsg.tool_call_id !== undefined &&
      toolCallIds.has(toolMsg.tool_call_id)
    ) {
      return typeof toolMsg.content === 'string'
        ? toolMsg.content
        : JSON.stringify(toolMsg.content);
    }
  }
  return undefined;
}

function baseMcpServerContext(
  permissionProfile: string,
): Record<string, unknown> {
  return {
    permissionProfile,
    wardenCwd: repoRoot,
    workspaceRoot: repoRoot,
    safeToolCwd: repoRoot,
    allowedWebFetchHosts: ['example.com'],
    parentSessionId: 'smoke',
    effectiveModels: {
      main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      roles: {},
    },
    agentCatalogIds: ['researcher'],
  };
}

async function main(): Promise<void> {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia454-parent-turn-smoke-'),
  );
  const dbPath = path.join(scratchRoot, 'checkpoints.db');
  const saver = SqliteSaver.fromConnString(dbPath);
  log('dbPath', dbPath);

  try {
    // ── Case A: multi-turn conversation, real cross-turn recall ──────────
    const threadId = crypto.randomUUID();
    const refToken = `REF-SMOKE-${crypto.randomBytes(4).toString('hex')}`;
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 2,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 3_000,
      onEvent: () => {},
    });

    log('=== Case A: turn 1 (states a fact under a unique token) ===', '');
    const turn1 = await runParentTurnViaCliSubprocess(
      {
        threadId,
        prompt:
          `Remember this for later in our conversation: the secret code is ` +
          `${refToken}. Just acknowledge you've noted it, in one short sentence.`,
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext('default'),
      },
      {
        pool,
        mcpServerScriptPath,
        mcpServerName,
        repoRoot,
        scratchDirFor: (id) => path.join(scratchRoot, id),
        saver,
      },
    );
    log('turn1 outcome', turn1);
    if (turn1.status !== 'success') {
      throw new Error(`Case A turn 1 FAILED: ${JSON.stringify(turn1)}`);
    }

    log(
      '=== Case A: turn 2 (asks about the token with NO other context) ===',
      '',
    );
    const turn2 = await runParentTurnViaCliSubprocess(
      {
        threadId,
        prompt:
          'What was the secret code I just told you? Reply with only the code.',
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext('default'),
      },
      {
        pool,
        mcpServerScriptPath,
        mcpServerName,
        repoRoot,
        scratchDirFor: (id) => path.join(scratchRoot, id),
        saver,
      },
    );
    log('turn2 outcome', turn2);
    if (turn2.status !== 'success') {
      throw new Error(`Case A turn 2 FAILED: ${JSON.stringify(turn2)}`);
    }
    if (!turn2.finalAssistantText.includes(refToken)) {
      throw new Error(
        `Case A FAILED: turn 2's answer did not contain the token from turn ` +
          `1 (${refToken}) — cross-turn recall did not work. Got: ` +
          `"${turn2.finalAssistantText}"`,
      );
    }
    log('Case A PASSED', `turn 2 correctly recalled ${refToken} from turn 1`);

    // ── Case B: nested dispatch through the parent's own 3-tool catalog ──
    log(
      '=== Case B: nested dispatch (dispatch_nested_agent -> researcher) ===',
      '',
    );
    const dispatchThreadId = crypto.randomUUID();
    const dispatchTurn = await runParentTurnViaCliSubprocess(
      {
        threadId: dispatchThreadId,
        prompt:
          'Call the tool named exactly ' +
          `"mcp__${mcpServerName}__dispatch_nested_agent" with agentId ` +
          '"researcher", model "claude-sonnet-4-6", prompt "In one sentence, ' +
          'what is TypeScript?", and outputContract {"name":"answer",' +
          '"schema":{"type":"object","properties":{"content":{"type":' +
          '"string"}},"required":["content"]}}. Then respond with only the ' +
          'returned content, no other prose.',
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext('default'),
      },
      {
        pool,
        mcpServerScriptPath,
        mcpServerName,
        repoRoot,
        scratchDirFor: (id) => path.join(scratchRoot, id),
        saver,
      },
    );
    log('dispatch outcome', dispatchTurn);
    if (dispatchTurn.status !== 'success') {
      throw new Error(`Case B FAILED: ${JSON.stringify(dispatchTurn)}`);
    }
    const dispatchResultContent = findDispatchToolResultContent(
      dispatchTurn.newMessages,
    );
    if (dispatchResultContent === undefined) {
      throw new Error(
        'Case B FAILED: no dispatch_nested_agent tool call/result found in ' +
          'the translated messages — the model may not have called the tool',
      );
    }
    // The tool RESULT itself is the oracle — never the model's own final
    // prose, which could (incorrectly) claim success even after a real
    // denial, or vice versa.
    if (dispatchResultContent.includes('permission_denied')) {
      throw new Error(
        `Case B FAILED: the real ALLOW path was unexpectedly denied — ` +
          `tool result: ${dispatchResultContent}`,
      );
    }
    if (!dispatchResultContent.includes('<nested-dispatch-output')) {
      throw new Error(
        `Case B FAILED: expected a real nested-dispatch-output envelope, ` +
          `got: ${dispatchResultContent}`,
      );
    }
    log(
      'Case B PASSED',
      'dispatch_nested_agent genuinely succeeded end-to-end (real tool result, no denial)',
    );

    // ── Case C: permission denial (read-only profile) ────────────────────
    log(
      '=== Case C: permission denial (read-only denies dispatch_nested_agent) ===',
      '',
    );
    const denyThreadId = crypto.randomUUID();
    const denyTurn = await runParentTurnViaCliSubprocess(
      {
        threadId: denyThreadId,
        prompt:
          'Call the tool named exactly ' +
          `"mcp__${mcpServerName}__dispatch_nested_agent" with agentId ` +
          '"researcher", model "claude-sonnet-4-6", prompt "test", and ' +
          'outputContract {"name":"x","schema":{"type":"object"}}. Then ' +
          "respond with a single line: either the tool's returned content, " +
          'or (if the call was denied/blocked) the literal string DENIED — ' +
          'never fabricate a success if you did not actually receive one.',
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext('read-only'),
      },
      {
        pool,
        mcpServerScriptPath,
        mcpServerName,
        repoRoot,
        scratchDirFor: (id) => path.join(scratchRoot, id),
        saver,
      },
    );
    log('deny outcome', denyTurn);
    if (denyTurn.status !== 'success') {
      throw new Error(
        `Case C FAILED (turn itself errored): ${JSON.stringify(denyTurn)}`,
      );
    }
    const denyResultContent = findDispatchToolResultContent(
      denyTurn.newMessages,
    );
    if (denyResultContent === undefined) {
      throw new Error(
        'Case C FAILED: no dispatch_nested_agent tool call/result found — ' +
          'the model may not have called the tool at all',
      );
    }
    // The REAL oracle: the denial must be the genuine read-only permission-
    // profile check (mcp-tool-gate.ts's `blocked by the "read-only"
    // permission profile` text), never a context-parsing failure or any
    // other unrelated deny path — those would prove nothing about the
    // actual permission mechanism this case exists to test.
    if (
      !denyResultContent.includes('permission_denied') ||
      !denyResultContent.includes('read-only')
    ) {
      throw new Error(
        `Case C FAILED: expected a genuine read-only permission-profile ` +
          `denial, got: ${denyResultContent}`,
      );
    }
    if (!denyTurn.finalAssistantText.toUpperCase().includes('DENIED')) {
      throw new Error(
        `Case C FAILED: model did not report DENIED — got: ` +
          `"${denyTurn.finalAssistantText}" (possible fabricated success)`,
      );
    }
    log(
      'Case C PASSED',
      'model correctly reported the REAL read-only permission-profile denial, no fabricated success',
    );

    await pool.shutdownAll();

    // ── Case D: independent checkpoint durability re-read ────────────────
    log(
      '=== Case D: independent checkpoint re-read (fresh SqliteSaver instance) ===',
      '',
    );
    const freshSaver = SqliteSaver.fromConnString(dbPath);
    const tuple = await freshSaver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: '' },
    });
    if (tuple === undefined) {
      throw new Error(
        'Case D FAILED: no checkpoint found for the smoke thread',
      );
    }
    const persistedMessages = tuple.checkpoint.channel_values[
      'messages'
    ] as unknown[];
    if (!Array.isArray(persistedMessages) || persistedMessages.length < 4) {
      throw new Error(
        `Case D FAILED: expected at least 4 persisted messages (2 turns x ` +
          `human+assistant), got ${JSON.stringify(persistedMessages)}`,
      );
    }
    log(
      'Case D PASSED',
      `${persistedMessages.length} messages genuinely persisted across both turns, re-read from a fresh saver instance`,
    );

    log(
      'DONE',
      'all 4 cases passed — zero 429s, real cross-turn recall, real nested dispatch, real denial, real durable persistence',
    );
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[lia454-parent-smoke] FAILED:', err);
  process.exitCode = 1;
});
