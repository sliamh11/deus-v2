/**
 * Tests for `TurnUsageCollector` — `record()`'s existing message-array
 * behavior plus `recordRaw()` (LIA-460: folds a flat, already-parsed usage
 * record directly, for the CLI-subprocess nested-dispatch usage side
 * channel, without requiring a synthetic LangChain message).
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { createTurnUsageCollector } from './deus-native-usage.js';
import type { RuntimeEvent } from './types.js';

function collectorWithSink(): {
  events: RuntimeEvent[];
  collector: ReturnType<typeof createTurnUsageCollector>;
} {
  const events: RuntimeEvent[] = [];
  const collector = createTurnUsageCollector({
    sessionId: 'session-1',
    eventSink: async (event) => {
      events.push(event);
    },
  });
  return { events, collector };
}

describe('TurnUsageCollector.record (existing behavior, unchanged)', () => {
  it('emits one usage event per AIMessage and folds into the running aggregate', async () => {
    const { events, collector } = collectorWithSink();
    const messages = [
      new HumanMessage('hi'),
      new AIMessage({
        content: 'ok',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      }),
    ];
    const local = await collector.record(messages, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(local).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }),
    ]);
    expect(collector.aggregate()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });
});

describe('TurnUsageCollector.recordRaw (LIA-460)', () => {
  it('emits the usage event unconditionally and folds into the running aggregate when all three token fields are present', async () => {
    const { events, collector } = collectorWithSink();
    await collector.recordRaw(
      { inputTokens: 29_794, outputTokens: 2, totalTokens: 29_796 },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    );

    expect(events).toEqual([
      {
        type: 'usage',
        sessionId: 'session-1',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 29_794,
        outputTokens: 2,
        totalTokens: 29_796,
      },
    ]);
    expect(collector.aggregate()).toEqual({
      inputTokens: 29_794,
      outputTokens: 2,
      totalTokens: 29_796,
    });
  });

  it('emits the usage event even when a token field is missing, but does NOT fold it into the aggregate (never introduces NaN)', async () => {
    const { events, collector } = collectorWithSink();
    await collector.recordRaw(
      { inputTokens: undefined, outputTokens: 2, totalTokens: 10 },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'usage', inputTokens: undefined });
    // The aggregate must stay undefined -- folding a partial record would
    // poison it with NaN, not silently produce a wrong-but-finite number.
    expect(collector.aggregate()).toBeUndefined();
  });

  it('accumulates across multiple recordRaw calls, combined with any prior record() calls too (parent-plus-every-child total)', async () => {
    const { collector } = collectorWithSink();
    await collector.record(
      [
        new AIMessage({
          content: 'parent reply',
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
          },
        }),
      ],
      { provider: 'anthropic', model: 'claude-opus-4-8' },
    );
    await collector.recordRaw(
      { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    );
    await collector.recordRaw(
      { inputTokens: 300, outputTokens: 30, totalTokens: 330 },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    );

    expect(collector.aggregate()).toEqual({
      inputTokens: 600,
      outputTokens: 60,
      totalTokens: 660,
    });
  });

  it('does not return a local aggregate (no caller of this method needs one)', async () => {
    const { collector } = collectorWithSink();
    const result = await collector.recordRaw(
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    );
    expect(result).toBeUndefined();
  });
});
