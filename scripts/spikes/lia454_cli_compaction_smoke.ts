/**
 * LIA-454 EP-002 step 6: real end-to-end proof that the CLI-backed
 * compaction path works — a real `SqliteSaver`, a real CLI-authored
 * checkpoint (via `checkpoint-translation.ts`), a real `createAgent` +
 * `buildContextCompactionMiddleware` (UNCHANGED — this is the whole point:
 * no changes to context-compaction.ts were needed), and a real
 * `CliSummaryModel` spawning an actual `claude` CLI subprocess for the
 * summary call, never `buildNativeModelClient()`/raw-HTTP.
 *
 * Run: npx tsx scripts/spikes/lia454_cli_compaction_smoke.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgent, FakeToolCallingModel } from 'langchain';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { buildContextCompactionMiddleware } from '../../src/agent-runtimes/context-compaction.js';
import {
  persistCliCheckpoint,
  translateCliTurnResult,
} from '../../src/agent-runtimes/cli-subprocess/checkpoint-translation.js';
import { CliSummaryModel } from '../../src/agent-runtimes/cli-subprocess/cli-summary-model.js';
import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia454-cli-compaction-'));
  const dbPath = path.join(dir, 'checkpoints.db');
  const saver = SqliteSaver.fromConnString(dbPath);
  const threadId = crypto.randomUUID();

  try {
    // 1. Build a synthetic long history (CLI-authored, via checkpoint-
    // translation.ts) — enough turns to exceed a deliberately low test
    // threshold, so compaction actually fires on the very next real turn.
    const topics = [
      'the billing migration timeline',
      'the retry backoff strategy',
      'the orders-table schema change',
      'the flaky payment webhook test',
      'the queue-vs-polling decision',
    ];
    let allMessages: (HumanMessage | AIMessage)[] = [];
    for (let i = 0; i < topics.length; i++) {
      const translated = translateCliTurnResult({
        currentTurnMessageId: `h-${i}`,
        prompt: `Turn ${i}: tell me about ${topics[i]}. Please be detailed and reference identifier REF-${1000 + i}.`,
        turnEvents: [
          {
            type: 'assistant',
            session_id: 's1',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              id: `a-${i}`,
              model: 'claude-sonnet-5',
              content: [
                {
                  type: 'text',
                  text: `Turn ${i} answer about ${topics[i]}: we decided to proceed carefully, tracked under REF-${1000 + i}, with a follow-up planned once traffic grows.`,
                },
              ],
            },
          },
        ],
        mcpServerName: 'unused',
        registeredToolNames: [],
        priorMessages: allMessages,
      });
      allMessages = [...allMessages, ...translated.messages];
    }

    await persistCliCheckpoint({
      saver,
      threadId,
      priorTuple: undefined,
      newMessages: allMessages,
    });
    const priorTuple = await saver.getTuple({
      configurable: { thread_id: threadId },
    });
    console.log(
      `Seeded ${allMessages.length} messages as a real CLI-authored checkpoint.`,
    );

    // 2. Real CLI-backed summary model, wired to a real pool (real `claude`
    // subprocess, no MCP server — genuinely no-tools mode).
    const pool = new ClaudeCliSessionPool({
      maxProcesses: 1,
      idleTimeoutMs: 60_000,
      terminationGraceMs: 3_000,
      onEvent: () => {},
    });
    const summaryModel = new CliSummaryModel({
      pool,
      model: 'claude-sonnet-5',
      repoRoot: process.cwd(),
      scratchDirFor: (id) => path.join(dir, id),
    });

    // 3. buildContextCompactionMiddleware, COMPLETELY UNCHANGED — a
    // deliberately tiny threshold so this real, small seeded history
    // actually triggers compaction on the next turn.
    const compaction = buildContextCompactionMiddleware(summaryModel, {
      tokenThreshold: 200,
      messagesToKeep: 2,
      summaryInputTokens: 4000,
    });

    // 4. A real createAgent, real checkpointer, resuming the CLI-authored
    // thread. FakeToolCallingModel stands in for the PARENT's own answer
    // (not the summary — that's the real CLI call above) since this smoke
    // proves the compaction seam, not the parent-turn-runner (a later step).
    const model = new FakeToolCallingModel({ toolCalls: [[]] });
    const agent = createAgent({
      model,
      tools: [],
      middleware: [compaction],
      checkpointer: saver,
    });

    const beforeCount = allMessages.length;
    const result = await agent.invoke(
      {
        messages: [
          new HumanMessage({
            id: 'h-followup',
            content: 'One more thing — what was REF-1002 about again?',
          }),
        ],
      },
      { configurable: { thread_id: threadId } },
    );

    const summaryMessage = result.messages.find(
      (m) =>
        typeof m.content === 'string' &&
        m.content.startsWith("Here is Deus's compacted conversation summary:"),
    );

    console.log(`\nMessages before this turn: ${beforeCount}`);
    console.log(
      `Messages after this turn (post-compaction): ${result.messages.length}`,
    );
    console.log(`Compaction fired: ${summaryMessage !== undefined}`);
    if (summaryMessage) {
      console.log(
        `\nReal CLI-generated summary text:\n${String(summaryMessage.content).slice(0, 500)}`,
      );
    }
    console.log(
      `\nMentions REF-1002 or REF-1003/REF-1004 (proving real content, not a stub): ` +
        `${/REF-100[234]/.test(String(summaryMessage?.content ?? ''))}`,
    );

    if (summaryMessage === undefined) {
      throw new Error(
        'SMOKE FAILED: compaction did not fire — no summary message found',
      );
    }
    console.log(
      '\nSMOKE PASSED: real CLI-authored checkpoint compacted via a real CLI subprocess call, buildContextCompactionMiddleware unchanged.',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
