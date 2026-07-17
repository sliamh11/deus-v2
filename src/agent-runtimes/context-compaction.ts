/**
 * Checkpoint-aware conversation compaction for the `deus-native` runtime
 * (LIA-419 / D5).
 *
 * This module deliberately owns policy while delegating message-reducer
 * mechanics to langchain@1.5.3's installed `summarizationMiddleware`. The
 * installed middleware runs in `beforeModel`, counts the checkpoint-loaded
 * messages plus the current input, and replaces an over-threshold history
 * with `RemoveMessage(REMOVE_ALL_MESSAGES)`, one summary `HumanMessage`, and
 * a recent suffix. That state update is then persisted by the same LangGraph
 * checkpointer already attached to the parent agent.
 *
 * Deus uses an absolute approximate-token threshold rather than LangChain's
 * fractional trigger. The installed model-profile lookup does not recognize
 * every model in Deus's allowlist (notably `claude-opus-4-8` currently has an
 * empty profile and falls back to 4,097 tokens), which would make a percentage
 * trigger compact far too early. The production threshold is therefore
 * explicit, documented, and independently testable.
 */

import {
  summarizationMiddleware,
  type AgentMiddleware,
  type TokenCounter,
} from 'langchain';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';

import { UserError } from '../errors/index.js';

/** Environment variable controlling the native runtime's compaction trigger. */
export const COMPACTION_TOKEN_THRESHOLD_ENV =
  'DEUS_NATIVE_COMPACTION_TOKEN_THRESHOLD';

/**
 * Default trigger: 150k approximate input tokens. This is conservative for
 * the currently allowlisted native models while leaving room for the summary
 * request, retained recent messages, tools, and model output.
 */
export const DEFAULT_COMPACTION_TOKEN_THRESHOLD = 150_000;

/** Recent context retained verbatim alongside the generated continuity summary. */
export const DEFAULT_COMPACTION_MESSAGES_TO_KEEP = 8;

/**
 * Avoid LangChain's 4k default summary-input trim, which is too small to carry
 * old decisions and identifiers reliably once a long-running session crosses
 * Deus's 150k trigger.
 */
export const DEFAULT_COMPACTION_SUMMARY_INPUT_TOKENS = 150_000;

/** Stable prefix used both for model context and failure-shape recognition. */
export const COMPACTION_SUMMARY_PREFIX =
  'Here is Deus\'s compacted conversation summary:';

/**
 * The categories are explicit so compaction preserves operational continuity,
 * not merely a prose synopsis. `{messages}` is replaced by LangChain.
 */
export const COMPACTION_SUMMARY_PROMPT = `<role>
You create continuity summaries for Deus, a personal AI assistant.
</role>

<instructions>
Summarize the conversation history below so a later turn can continue without
access to the removed messages. Preserve exact names, identifiers, user
preferences, constraints, decisions and rationale, completed actions and
artifacts, unresolved questions, and the next intended steps. Preserve tool
results when they affect later work. Do not invent facts. Be concise, but never
drop a detail needed to continue coherently.

Respond only with the continuity summary.
</instructions>

<messages>
{messages}
</messages>`;

export interface ContextCompactionConfig {
  /** Approximate total message tokens at which compaction starts (inclusive). */
  tokenThreshold: number;
  /** Number of newest messages retained verbatim after the summary. */
  messagesToKeep: number;
  /** Maximum old-history tokens supplied to the summarizer. */
  summaryInputTokens: number;
}

export interface BuildContextCompactionDeps {
  /** Hermetic token counter override for tests; production uses LangChain's approximation. */
  tokenCounter?: TokenCounter;
}

/**
 * Resolves the dedicated native-compaction threshold. Invalid configured
 * values fail visibly: silently accepting zero/NaN would disable the safety
 * boundary while the operator believed it was active.
 */
export function resolveContextCompactionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContextCompactionConfig {
  const raw = env[COMPACTION_TOKEN_THRESHOLD_ENV];
  const tokenThreshold =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_COMPACTION_TOKEN_THRESHOLD
      : Number(raw);
  if (!Number.isSafeInteger(tokenThreshold) || tokenThreshold <= 0) {
    throw new UserError(
      `${COMPACTION_TOKEN_THRESHOLD_ENV} must be a positive integer, got ` +
        JSON.stringify(raw),
    );
  }
  return {
    tokenThreshold,
    messagesToKeep: DEFAULT_COMPACTION_MESSAGES_TO_KEEP,
    summaryInputTokens: DEFAULT_COMPACTION_SUMMARY_INPUT_TOKENS,
  };
}

/** True only for the installed middleware's synthetic failed-summary update. */
function containsFailedSummary(update: unknown): boolean {
  if (typeof update !== 'object' || update === null) return false;
  const messages = (update as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const candidate = message as {
      content?: unknown;
      additional_kwargs?: Record<string, unknown>;
    };
    return (
      candidate.additional_kwargs?.['lc_source'] === 'summarization' &&
      typeof candidate.content === 'string' &&
      (candidate.content.includes('\n\nError generating summary:') ||
        candidate.content.includes(
          '\n\nError generating summary: Invalid response format',
        ))
    );
  });
}

/**
 * Builds the outermost parent-session middleware.
 *
 * LangChain 1.5.3 catches summarizer failures and turns them into an error
 * string while still returning the destructive remove-all state update. The
 * wrapper recognizes that installed failure contract and drops the update,
 * leaving the original checkpointed history intact (fail open for continuity).
 */
export function buildContextCompactionMiddleware(
  model: BaseLanguageModel,
  config: ContextCompactionConfig = resolveContextCompactionConfig(),
  deps: BuildContextCompactionDeps = {},
): AgentMiddleware {
  const builtIn = summarizationMiddleware({
    model,
    trigger: { tokens: config.tokenThreshold },
    keep: { messages: config.messagesToKeep },
    trimTokensToSummarize: config.summaryInputTokens,
    summaryPrompt: COMPACTION_SUMMARY_PROMPT,
    summaryPrefix: COMPACTION_SUMMARY_PREFIX,
    ...(deps.tokenCounter !== undefined
      ? { tokenCounter: deps.tokenCounter }
      : {}),
  });
  const hookDefinition = builtIn.beforeModel;
  const beforeModel =
    typeof hookDefinition === 'function'
      ? hookDefinition
      : hookDefinition?.hook;
  if (beforeModel === undefined) {
    throw new UserError(
      'langchain summarizationMiddleware did not provide a beforeModel hook',
    );
  }

  const guardedBeforeModel: typeof beforeModel = async (state, runtime) => {
    const update = await beforeModel(state, runtime);
    if (containsFailedSummary(update)) return;
    return update;
  };

  // Preserve LangChain's context schema and middleware type configuration;
  // only the hook and human-readable layer name are replaced.
  return {
    ...builtIn,
    name: 'context-compaction',
    beforeModel: guardedBeforeModel,
  };
}
