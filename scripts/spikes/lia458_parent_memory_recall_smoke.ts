/**
 * LIA-458: real credentialed smoke test proving control-group memory-recall
 * genuinely reaches the LIVE CLI turn that answers the SAME message it was
 * fetched for — not just the persisted checkpoint (the round-1 plan-review
 * bug this ticket's design specifically fixes).
 *
 * Mirrors `lia454_parent_turn_cli_subprocess_smoke.ts`'s own structure and
 * standard (real `claude` CLI binary, real OAuth, a real temp-file
 * `SqliteSaver`). Calls `runParentTurnViaCliSubprocess` directly with a
 * hand-crafted `recalledMemoryContext` — this does NOT exercise the real
 * `memory_retrieval_hook.py` against the user's actual personal vault (that
 * script is unchanged/pre-existing and already relied upon by the raw-HTTP
 * path); the new surface this ticket adds is the call-site wiring in
 * `deus-native-backend.ts` (covered by unit tests) and the live-prompt
 * injection in `parent-turn-runner.ts` (the real oracle this script proves).
 *
 * The REAL oracle: a SINGLE turn, on a brand-new thread, whose prompt itself
 * never mentions the fact — only `recalledMemoryContext` does. If the model's
 * answer to THIS turn reflects the fact, recall reached the live call. If it
 * doesn't show up until a hypothetical follow-up turn's history, that would
 * prove the round-1 bug (checkpoint-only, no same-turn visibility) is back.
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * NOT a CI-safe test (same category as the LIA-454/LIA-457 parent-turn
 * smokes). Run manually:
 *   npx tsx scripts/spikes/lia458_parent_memory_recall_smoke.ts
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
const mcpServerName = 'deus_lia458_recall_smoke';

function log(label: string, detail: unknown): void {
  console.log(`[lia458-recall-smoke] ${label}:`, detail);
}

function baseMcpServerContext(): Record<string, unknown> {
  return {
    permissionProfile: 'default',
    wardenCwd: repoRoot,
    workspaceRoot: repoRoot,
    safeToolCwd: repoRoot,
    allowedWebFetchHosts: ['example.com'],
    parentSessionId: 'smoke',
    effectiveModels: {
      main: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      roles: {},
    },
    agentCatalogIds: [],
  };
}

async function main(): Promise<void> {
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lia458-parent-recall-smoke-'),
  );
  const dbPath = path.join(scratchRoot, 'checkpoints.db');
  const saver = SqliteSaver.fromConnString(dbPath);
  log('dbPath', dbPath);

  try {
    const threadId = crypto.randomUUID();
    const recalledFact = `The user's favorite fictional planet is Zorlax-${crypto.randomBytes(3).toString('hex')}.`;
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 2,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 3_000,
      onEvent: () => {},
    });

    log(
      '=== Single turn: prompt never mentions the fact, only recalledMemoryContext does ===',
      '',
    );
    const turn = await runParentTurnViaCliSubprocess(
      {
        threadId,
        prompt:
          "What is my favorite fictional planet? Reply with only the planet's name.",
        currentTurnMessageId: crypto.randomUUID(),
        recalledMemoryContext: recalledFact,
        mcpServerContext: baseMcpServerContext(),
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
    log('turn outcome', turn);
    if (turn.status !== 'success') {
      throw new Error(`Turn FAILED: ${JSON.stringify(turn)}`);
    }
    if (!turn.finalAssistantText.includes('Zorlax')) {
      throw new Error(
        `FAILED: the SAME turn's answer did not reflect the recalled fact ` +
          `— recall did not reach the live CLI call (the round-1 bug this ` +
          `ticket fixes). Got: "${turn.finalAssistantText}"`,
      );
    }
    log(
      'PASSED (same-turn recall)',
      `turn 1's own answer reflected the recalled fact ("${turn.finalAssistantText}") — recalledMemoryContext genuinely reached the LIVE CLI call, not just the checkpoint`,
    );

    await pool.shutdownAll();

    log(
      '=== Independent checkpoint re-read: confirm the persisted current-turn message stayed the bare prompt ===',
      '',
    );
    const freshSaver = SqliteSaver.fromConnString(dbPath);
    const tuple = await freshSaver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: '' },
    });
    if (tuple === undefined) {
      throw new Error('FAILED: no checkpoint found for the smoke thread');
    }
    const persistedMessages = tuple.checkpoint.channel_values[
      'messages'
    ] as Array<{ content?: unknown }>;
    const bareUserMessage = persistedMessages.find(
      (m) =>
        typeof m.content === 'string' &&
        m.content.includes('favorite fictional planet') &&
        !m.content.includes('Zorlax'),
    );
    if (bareUserMessage === undefined) {
      throw new Error(
        'FAILED: could not find the persisted current-turn message as the ' +
          'bare, unaugmented prompt — the live/persisted split may have ' +
          'leaked into each other',
      );
    }
    const recalledContextMessage = persistedMessages.find(
      (m) => typeof m.content === 'string' && m.content === recalledFact,
    );
    if (recalledContextMessage === undefined) {
      throw new Error(
        'FAILED: the recalled context is not separately persisted for ' +
          'next-turn history — the pre-existing checkpoint-translation ' +
          'mechanism may have regressed',
      );
    }
    log(
      'PASSED (persisted split)',
      'the persisted current-turn message stayed the bare prompt, and the recalled context is separately persisted for next-turn history',
    );

    log(
      'DONE',
      'recalled memory context genuinely reached the SAME turn it was fetched for, and the persisted checkpoint correctly kept the live-vs-persisted split.',
    );
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[lia458-recall-smoke] FAILED:', err);
  process.exitCode = 1;
});
