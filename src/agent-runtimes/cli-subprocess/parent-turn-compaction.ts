/**
 * Context-compaction dry run for the CLI-subprocess parent transport
 * (LIA-457, follow-up to LIA-454/EP-002 step 11's deferred scope).
 *
 * EP-002 deferred compaction here because `buildContextCompactionMiddleware`'s
 * `beforeModel` hook only ever fired inside a real LangGraph `agent.invoke()`
 * — there's no graph running for a CLI-subprocess turn — and naively porting
 * it (an ephemeral checkpointer + a stand-in model + a full `agent.invoke()`)
 * risked writing a fabricated turn into the real production checkpoint.
 *
 * This module avoids that risk entirely by calling the middleware's
 * `beforeModel` hook DIRECTLY as a plain function — no graph, no
 * checkpointer, no stand-in model turn. `context-compaction.ts`'s own
 * `buildContextCompactionMiddleware` already unwraps whatever shape
 * `createMiddleware` produces down to a plain callable async function on
 * `.beforeModel`; `context-compaction.test.ts`'s own `invokeBeforeModel`
 * helper already calls it exactly this way in tests. This module promotes
 * that existing, already-tested internal pattern to production.
 *
 * KNOWN SIDE EFFECT (verified, benign, not a bug): both the installed
 * `summarizationMiddleware`'s `ensureMessageIds` and `messagesStateReducer`'s
 * own left-side backfill mutate message objects IN PLACE to assign a missing
 * `.id`. Since callers pass the same object references backing the real
 * checkpoint's `channel_values['messages']`, an id can be backfilled even on
 * a non-compacting (`compacted: false`) dry run — `ensureMessageIds` runs
 * unconditionally, before the token-threshold check. This can only ever ADD a
 * missing id, never change content, and `SqliteSaver.getTuple()` deserializes
 * fresh from the durable BLOB on every read, so it cannot corrupt anything
 * already persisted.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { messagesStateReducer } from '@langchain/langgraph';

import {
  buildContextCompactionMiddleware,
  type ContextCompactionConfig,
} from '../context-compaction.js';

export interface CompactParentHistoryResult {
  messages: BaseMessage[];
  compacted: boolean;
}

/**
 * Type of `AgentMiddleware['beforeModel']` once unwrapped to a plain
 * callable — matches `context-compaction.test.ts`'s own `DirectHook` type,
 * since `buildContextCompactionMiddleware` guarantees this shape (never the
 * `{hook}`-wrapped alternative some middleware frameworks use).
 */
type DirectBeforeModelHook = (
  state: { messages: BaseMessage[] },
  runtime: { context: Record<string, never> },
) => Promise<{ messages: BaseMessage[] } | undefined>;

/**
 * Runs the context-compaction dry run for a CLI-subprocess parent turn.
 *
 * Below the configured token threshold, `beforeModel` returns `undefined`
 * without ever calling `summaryModel` — the threshold check runs before any
 * model invocation in the installed source — so calling this unconditionally
 * every turn costs nothing when compaction isn't needed.
 */
export async function maybeCompactParentHistory(
  priorMessages: BaseMessage[],
  summaryModel: BaseChatModel,
  config?: ContextCompactionConfig,
): Promise<CompactParentHistoryResult> {
  const middleware = buildContextCompactionMiddleware(summaryModel, config);
  const hook = middleware.beforeModel as unknown as DirectBeforeModelHook;

  const update = await hook({ messages: priorMessages }, { context: {} });
  if (update === undefined) {
    return { messages: priorMessages, compacted: false };
  }

  // The official LangGraph reducer for the `messages` channel — correctly
  // interprets the `RemoveMessage(REMOVE_ALL_MESSAGES)` sentinel the same way
  // `Pregel`'s own loop would, so this stays correct even if a future
  // langchain bump changes the exact array shape `beforeModel` returns.
  const messages = messagesStateReducer(priorMessages, update.messages);
  return { messages, compacted: true };
}
