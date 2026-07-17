import { describe, expect, it, vi } from 'vitest';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  RemoveMessage,
} from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type { AgentMiddleware } from 'langchain';

import { UserError } from '../errors/index.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_TOKEN_THRESHOLD_ENV,
  DEFAULT_COMPACTION_MESSAGES_TO_KEEP,
  DEFAULT_COMPACTION_SUMMARY_INPUT_TOKENS,
  DEFAULT_COMPACTION_TOKEN_THRESHOLD,
  buildContextCompactionMiddleware,
  resolveContextCompactionConfig,
  type ContextCompactionConfig,
} from './context-compaction.js';

const TEST_CONFIG: ContextCompactionConfig = {
  tokenThreshold: 10,
  messagesToKeep: 2,
  summaryInputTokens: 1_000,
};

/**
 * Calls the hook directly instead of constructing a full agent graph. The
 * installed LangChain hook requires `runtime.context` to be an object even
 * when no per-invocation override is supplied, so the minimal fixture includes
 * that otherwise-unused field deliberately.
 */
async function invokeBeforeModel(
  middleware: AgentMiddleware,
  messages: BaseMessage[],
): Promise<unknown> {
  const definition = middleware.beforeModel;
  const hook = typeof definition === 'function' ? definition : definition?.hook;
  if (hook === undefined) {
    throw new Error('test fixture expected a beforeModel hook');
  }
  type DirectHook = (
    state: { messages: BaseMessage[] },
    runtime: { context: Record<string, never> },
  ) => unknown;
  return await (hook as unknown as DirectHook)({ messages }, { context: {} });
}

/** Five messages ensure the two-message retained suffix has an older prefix. */
function conversationFixture(): BaseMessage[] {
  return [
    new HumanMessage({ id: 'human-1', content: 'old requirement' }),
    new AIMessage({ id: 'ai-1', content: 'acknowledged' }),
    new HumanMessage({ id: 'human-2', content: 'older decision' }),
    new AIMessage({ id: 'ai-2', content: 'decision recorded' }),
    new HumanMessage({ id: 'human-3', content: 'latest request' }),
  ];
}

describe('resolveContextCompactionConfig', () => {
  it.each([undefined, '', '   '])(
    'uses documented defaults when the threshold is %j',
    (raw) => {
      const env: NodeJS.ProcessEnv = {};
      if (raw !== undefined) env[COMPACTION_TOKEN_THRESHOLD_ENV] = raw;

      expect(resolveContextCompactionConfig(env)).toEqual({
        tokenThreshold: DEFAULT_COMPACTION_TOKEN_THRESHOLD,
        messagesToKeep: DEFAULT_COMPACTION_MESSAGES_TO_KEEP,
        summaryInputTokens: DEFAULT_COMPACTION_SUMMARY_INPUT_TOKENS,
      });
    },
  );

  it('accepts a positive integer override', () => {
    expect(
      resolveContextCompactionConfig({
        [COMPACTION_TOKEN_THRESHOLD_ENV]: '42000',
      }),
    ).toMatchObject({ tokenThreshold: 42_000 });
  });

  it.each(['0', '-1', '1.5', 'NaN', 'not-a-number'])(
    'rejects invalid threshold %j with UserError',
    (raw) => {
      expect(() =>
        resolveContextCompactionConfig({
          [COMPACTION_TOKEN_THRESHOLD_ENV]: raw,
        }),
      ).toThrow(UserError);
    },
  );
});

describe('buildContextCompactionMiddleware', () => {
  it('is a strict no-op below the threshold and never calls the summarizer', async () => {
    const model = new FakeListChatModel({ responses: ['unused summary'] });
    const invokeSpy = vi.spyOn(model, 'invoke');
    const messages = conversationFixture();
    const middleware = buildContextCompactionMiddleware(model, TEST_CONFIG, {
      tokenCounter: async () => TEST_CONFIG.tokenThreshold - 1,
    });

    await expect(
      invokeBeforeModel(middleware, messages),
    ).resolves.toBeUndefined();
    expect(invokeSpy).not.toHaveBeenCalled();
    // No update means LangGraph's checkpointed history remains byte-for-byte
    // under the existing messages reducer.
    expect(messages.map((message) => message.id)).toEqual([
      'human-1',
      'ai-1',
      'human-2',
      'ai-2',
      'human-3',
    ]);
  });

  it.each([
    ['at', TEST_CONFIG.tokenThreshold],
    ['above', TEST_CONFIG.tokenThreshold + 1],
  ] as const)(
    'returns a destructive replacement update %s the threshold while preserving the salient fact and recent suffix',
    async (_label, tokenCount) => {
      const salientFact = 'the deployment key is rotated to v7';
      const model = new FakeListChatModel({
        responses: [`the salient fact: ${salientFact}`],
      });
      const messages = conversationFixture();
      const middleware = buildContextCompactionMiddleware(model, TEST_CONFIG, {
        // Fixed counts make the inclusive trigger contract deterministic and
        // independent of tokenizers or fixture wording.
        tokenCounter: async () => tokenCount,
      });

      const update = (await invokeBeforeModel(middleware, messages)) as {
        messages: BaseMessage[];
      };

      expect(update.messages).toHaveLength(2 + TEST_CONFIG.messagesToKeep);
      expect(RemoveMessage.isInstance(update.messages[0])).toBe(true);
      expect(update.messages[0].id).toBe(REMOVE_ALL_MESSAGES);

      const summaryContent = update.messages[1].content;
      expect(typeof summaryContent).toBe('string');
      expect(summaryContent).toSatisfy((content: unknown) =>
        typeof content === 'string'
          ? content.startsWith(COMPACTION_SUMMARY_PREFIX)
          : false,
      );
      expect(summaryContent).toContain(salientFact);

      const preserved = update.messages.slice(2);
      expect(preserved).toHaveLength(TEST_CONFIG.messagesToKeep);
      expect(preserved).toEqual(messages.slice(-TEST_CONFIG.messagesToKeep));
    },
  );

  it('fails open when the summarization model rejects', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('boom');
    });
    // LangChain's summarizer only calls invoke() at this seam. Keeping the
    // rejecting fixture minimal ensures this test exercises Deus's guard, not
    // unrelated chat-model behavior.
    const model = { invoke } as unknown as BaseLanguageModel;
    const middleware = buildContextCompactionMiddleware(model, TEST_CONFIG, {
      tokenCounter: async () => TEST_CONFIG.tokenThreshold,
    });

    await expect(
      invokeBeforeModel(middleware, conversationFixture()),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
