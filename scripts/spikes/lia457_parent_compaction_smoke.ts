/**
 * LIA-457: real credentialed smoke test proving context-compaction actually
 * works end-to-end on the CLI-subprocess parent transport — a long
 * conversation compacts and continues instead of hard-failing, and a REAL
 * (not stubbed) CLI-authored summary is what makes cross-turn recall
 * survive the compaction.
 *
 * Mirrors `lia454_parent_turn_cli_subprocess_smoke.ts`'s own structure and
 * standard (real `claude` CLI binary, real OAuth, a real temp-file
 * `SqliteSaver`) — this script exercises the NEW compaction seam
 * specifically, not the transport's other already-proven behaviors.
 *
 * The threshold is forced low via `DEUS_NATIVE_COMPACTION_TOKEN_THRESHOLD`
 * (set on `process.env` before any turn runs) so a small, fast conversation
 * reliably triggers real compaction — the same lever
 * `resolveContextCompactionConfig()` reads in production.
 *
 * The REAL oracle here is not "did the turn succeed" (a no-op middleware
 * would also make that true) but "does turn 2 still correctly recall turn
 * 1's fact, even though turn 1's raw messages were compacted away and only
 * a genuine CLI-generated summary remains" — proving the summary actually
 * carried the salient detail forward, not a stub.
 *
 * Requires a real `claude` CLI binary on PATH with real OAuth credentials —
 * NOT a CI-safe test (same category as the LIA-454 parent-turn smoke). Run
 * manually:
 *   npx tsx scripts/spikes/lia457_parent_compaction_smoke.ts
 */
process.env.DEUS_NATIVE_COMPACTION_TOKEN_THRESHOLD = '1';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';

import { COMPACTION_SUMMARY_PREFIX } from '../../src/agent-runtimes/context-compaction.js';
import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import { persistCliCheckpoint } from '../../src/agent-runtimes/cli-subprocess/checkpoint-translation.js';
import { runParentTurnViaCliSubprocess } from '../../src/agent-runtimes/cli-subprocess/parent-turn-runner.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDirectory, '../..');
const mcpServerScriptPath = path.resolve(
  repoRoot,
  'src/agent-runtimes/cli-subprocess/parent-turn-mcp-server.ts',
);
const mcpServerName = 'deus_lia457_compaction_smoke';

function log(label: string, detail: unknown): void {
  console.log(`[lia457-compaction-smoke] ${label}:`, detail);
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
    path.join(os.tmpdir(), 'lia457-parent-compaction-smoke-'),
  );
  const dbPath = path.join(scratchRoot, 'checkpoints.db');
  const saver = SqliteSaver.fromConnString(dbPath);
  log('dbPath', dbPath);
  log('forced threshold', process.env.DEUS_NATIVE_COMPACTION_TOKEN_THRESHOLD);

  try {
    const threadId = crypto.randomUUID();
    const refToken = `REF-COMPACT-${crypto.randomBytes(4).toString('hex')}`;
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 4,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 3_000,
      onEvent: () => {},
    });
    const deps = {
      pool,
      mcpServerScriptPath,
      mcpServerName,
      repoRoot,
      scratchDirFor: (id: string) => path.join(scratchRoot, id),
      saver,
    };

    log('=== Turn 1: states a fact under a unique token ===', '');
    const turn1 = await runParentTurnViaCliSubprocess(
      {
        threadId,
        prompt:
          `Remember this for later in our conversation: the secret code is ` +
          `${refToken}. Just acknowledge you've noted it, in one short sentence.`,
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext(),
      },
      deps,
    );
    log('turn1 outcome', turn1);
    if (turn1.status !== 'success') {
      throw new Error(`Turn 1 FAILED: ${JSON.stringify(turn1)}`);
    }

    // `determineCutoffIndex`'s own `findSafeCutoff` returns cutoff 0 (nothing
    // to compact) whenever the message count is <=
    // DEFAULT_COMPACTION_MESSAGES_TO_KEEP (8) — a low token threshold alone
    // isn't enough to force a real cutoff. Seed 4 unrelated filler pairs (8
    // messages) directly, AFTER turn 1, so turn 1's fact-stating messages
    // become the OLDEST 2 of 10 total — guaranteed to fall in the
    // summarized portion, not the preserved tail, which is the whole point:
    // this proves the SUMMARY (not raw preserved text) is what carries the
    // fact forward.
    log('=== Seeding 4 filler turns to exceed the keep-8 window ===', '');
    const priorTuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: '' },
    });
    const fillerMessages: BaseMessage[] = [];
    for (let i = 0; i < 4; i++) {
      fillerMessages.push(
        new HumanMessage({
          id: `filler-h-${i}`,
          content: `Unrelated filler question ${i}, ignore this.`,
        }),
      );
      fillerMessages.push(
        new AIMessage({
          id: `filler-a-${i}`,
          content: `Unrelated filler answer ${i}.`,
        }),
      );
    }
    await persistCliCheckpoint({
      saver,
      threadId,
      priorTuple,
      newMessages: fillerMessages,
    });

    log(
      '=== Turn 2: forced-low-threshold compaction fires against turn 1 + filler, then asks about the token ===',
      '',
    );
    const turn2 = await runParentTurnViaCliSubprocess(
      {
        threadId,
        prompt:
          'What was the secret code I just told you? Reply with only the code.',
        currentTurnMessageId: crypto.randomUUID(),
        mcpServerContext: baseMcpServerContext(),
      },
      deps,
    );
    log('turn2 outcome', turn2);
    if (turn2.status !== 'success') {
      throw new Error(
        `Turn 2 FAILED (should have compacted and continued, not hard-failed): ${JSON.stringify(turn2)}`,
      );
    }
    if (!turn2.finalAssistantText.includes(refToken)) {
      throw new Error(
        `FAILED: turn 2's answer did not contain the token from turn 1 ` +
          `(${refToken}) — the real CLI-generated summary did not carry the ` +
          `salient fact forward. Got: "${turn2.finalAssistantText}"`,
      );
    }
    log(
      'PASSED (recall)',
      `turn 2 correctly recalled ${refToken} despite turn 1's raw history being compacted away`,
    );

    await pool.shutdownAll();

    log(
      '=== Independent checkpoint re-read: confirm a genuine summary message was persisted ===',
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
    const summaryMessage = persistedMessages.find(
      (m) =>
        typeof m.content === 'string' &&
        m.content.startsWith(COMPACTION_SUMMARY_PREFIX),
    );
    if (summaryMessage === undefined) {
      throw new Error(
        'FAILED: no persisted message carries the compaction summary prefix ' +
          '— compaction may not have actually fired/persisted',
      );
    }
    if (
      typeof summaryMessage.content === 'string' &&
      !summaryMessage.content.includes(refToken)
    ) {
      throw new Error(
        'FAILED: the persisted summary does not mention the ref token — ' +
          'the real summary content looks wrong, not just its presence',
      );
    }
    log(
      'PASSED (persistence)',
      `a real, genuine CLI-authored summary mentioning ${refToken} is durably persisted`,
    );

    log(
      'DONE',
      'compaction fired for real, the turn succeeded (no hard-fail), and cross-turn recall genuinely survived it',
    );
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[lia457-compaction-smoke] FAILED:', err);
  process.exitCode = 1;
});
