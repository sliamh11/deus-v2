/**
 * LIA-457: unit tests for `maybeCompactParentHistory`. Follows
 * `context-compaction.test.ts`'s own established convention
 * (`FakeListChatModel` + a `tokenCounter` override, no LangGraph
 * graph/checkpointer involved) rather than inventing a new mocking pattern.
 */
import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { BaseMessage } from '@langchain/core/messages';

import {
  COMPACTION_SUMMARY_PREFIX,
  type ContextCompactionConfig,
} from '../context-compaction.js';
import { maybeCompactParentHistory } from './parent-turn-compaction.js';

const TEST_CONFIG: ContextCompactionConfig = {
  tokenThreshold: 10,
  messagesToKeep: 2,
  summaryInputTokens: 1_000,
};

/** Five messages ensure the two-message retained suffix has an older prefix
 *  — mirrors `context-compaction.test.ts`'s own `conversationFixture`. */
function conversationFixture(): BaseMessage[] {
  return [
    new HumanMessage({ id: 'human-1', content: 'old requirement' }),
    new AIMessage({ id: 'ai-1', content: 'acknowledged' }),
    new HumanMessage({ id: 'human-2', content: 'older decision' }),
    new AIMessage({ id: 'ai-2', content: 'decision recorded' }),
    new HumanMessage({ id: 'human-3', content: 'latest request' }),
  ];
}

describe('maybeCompactParentHistory', () => {
  it('is a no-op below the threshold: returns the same messages, compacted:false, and never calls the summary model', async () => {
    const model = new FakeListChatModel({ responses: ['unused summary'] });
    const invokeSpy = vi.spyOn(model, 'invoke');
    const priorMessages = conversationFixture();

    // A tokenCounter override isn't part of this module's own signature
    // (config only carries threshold/keep/summaryInputTokens), so drive the
    // below-threshold path via a threshold the small fixture can't reach.
    const result = await maybeCompactParentHistory(priorMessages, model, {
      tokenThreshold: 1_000_000,
      messagesToKeep: TEST_CONFIG.messagesToKeep,
      summaryInputTokens: TEST_CONFIG.summaryInputTokens,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages.map((m) => m.content)).toEqual(
      priorMessages.map((m) => m.content),
    );
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('compacts above the threshold via the official messagesStateReducer, matching a hand-computed expected list', async () => {
    const salientFact = 'the deployment key is rotated to v7';
    const model = new FakeListChatModel({
      responses: [`the salient fact: ${salientFact}`],
    });
    const priorMessages = conversationFixture();

    // A near-zero threshold forces compaction regardless of the real
    // approximate token counter — deterministic without depending on the
    // exact fixture wording's token count.
    const result = await maybeCompactParentHistory(priorMessages, model, {
      tokenThreshold: 1,
      messagesToKeep: TEST_CONFIG.messagesToKeep,
      summaryInputTokens: TEST_CONFIG.summaryInputTokens,
    });

    expect(result.compacted).toBe(true);
    // messagesStateReducer applied REMOVE_ALL_MESSAGES: only the summary +
    // preserved tail remain, the RemoveMessage sentinel itself is gone (the
    // reducer consumes it, never returns it as a real message).
    expect(result.messages).toHaveLength(1 + TEST_CONFIG.messagesToKeep);
    const summaryContent = result.messages[0].content;
    expect(typeof summaryContent).toBe('string');
    expect(summaryContent).toSatisfy((content: unknown) =>
      typeof content === 'string'
        ? content.startsWith(COMPACTION_SUMMARY_PREFIX)
        : false,
    );
    expect(summaryContent).toContain(salientFact);

    const preserved = result.messages.slice(1);
    expect(preserved.map((m) => m.content)).toEqual(
      priorMessages.slice(-TEST_CONFIG.messagesToKeep).map((m) => m.content),
    );
  });

  it('degrades to uncompacted (never throws) when the summary model rejects — mirrors the CliSummaryModel null-slot path', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('CliSummaryModel: no CLI subprocess slot available (production-wide process cap reached)');
    });
    const model = { invoke } as unknown as FakeListChatModel;
    const priorMessages = conversationFixture();

    const result = await maybeCompactParentHistory(priorMessages, model, {
      tokenThreshold: 1,
      messagesToKeep: TEST_CONFIG.messagesToKeep,
      summaryInputTokens: TEST_CONFIG.summaryInputTokens,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(priorMessages);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('KNOWN SIDE EFFECT: a below-threshold dry run still backfills a missing message id in place, but never changes content', async () => {
    const model = new FakeListChatModel({ responses: ['unused'] });
    const priorMessages: BaseMessage[] = [
      new HumanMessage({ content: 'no id set on this one' }), // id omitted
      new AIMessage({ id: 'ai-1', content: 'has an id already' }),
    ];
    expect(priorMessages[0].id).toBeUndefined();

    const result = await maybeCompactParentHistory(priorMessages, model, {
      tokenThreshold: 1_000_000,
      messagesToKeep: TEST_CONFIG.messagesToKeep,
      summaryInputTokens: TEST_CONFIG.summaryInputTokens,
    });

    expect(result.compacted).toBe(false);
    // The id was backfilled in place (documented, benign — see module doc
    // comment)...
    expect(priorMessages[0].id).toBeDefined();
    // ...but content round-trips completely unchanged.
    expect(result.messages.map((m) => m.content)).toEqual([
      'no id set on this one',
      'has an id already',
    ]);
    expect(priorMessages[1].id).toBe('ai-1'); // untouched, already had one
  });
});
