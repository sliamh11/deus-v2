/**
 * A `BaseChatModel` that answers exactly one prompt via a fresh, no-tools
 * CLI-subprocess conversation (LIA-454 EP-002 step 6: the CLI-backed
 * compaction summarizer).
 *
 * `langchain`'s `summarizationMiddleware` (`node_modules/langchain/dist/
 * agents/middleware/summarization.js`, verified directly) calls
 * `model.invoke(formattedPrompt, config)` with a PLAIN STRING and reads
 * `.content` off the result — nothing else about its internals depends on
 * `model` being a raw-HTTP client. This means `buildContextCompactionMiddleware`
 * (`context-compaction.ts`) needs NO changes at all for the CLI path: passing
 * a `CliSummaryModel` instance as its `model` argument, in place of the
 * raw-HTTP `ChatAnthropic` client, is a complete, unmodified drop-in swap.
 * The plan's own step 6 wording ("extract a first-class operation") assumed
 * this seam might need extracting; reading the actual installed source
 * showed it doesn't.
 *
 * Deliberately does NOT call `buildNativeModelClient()` anywhere — that
 * would reintroduce the H1 raw-HTTP 429 precisely when compaction triggers,
 * the one raw-HTTP call the CLI-subprocess transport is designed to avoid.
 */
import crypto from 'node:crypto';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

import { ClaudeCliSessionPool } from './claude-cli-session-pool.js';
import {
  acquireProcessSlot as defaultAcquireProcessSlot,
  type AcquireProcessSlotOptions,
  type ProcessSlotLease,
} from './process-lifecycle-registry.js';

export class CliSummaryModelError extends Error {}

export interface CliSummaryModelOptions {
  pool: ClaudeCliSessionPool;
  /** The resolved main model id for this turn — the summary call uses the
   *  SAME model tier as the parent turn, never a hardcoded/different one. */
  model: string;
  /** Repo root, threaded through unused (no MCP server exists in no-tools
   *  mode) — required only because `CreateConversationOptions` itself
   *  requires it. */
  repoRoot: string;
  /** Caller decides the actual scratch path shape (e.g. under a turn-scoped
   *  temp dir), called once per summary call with a fresh conversation id. */
  scratchDirFor: (conversationId: string) => string;
  /** Production-wide process-slot acquisition (LIA-457) — defaults to the
   *  real `acquireProcessSlot` import, same default-fallback pattern
   *  `parent-turn-runner.ts` already uses for its own slot. A summary call
   *  spawns a genuinely separate CLI subprocess from the parent's own, so it
   *  must reserve its own slot against the same production-wide cap. */
  acquireProcessSlot?: (
    options?: AcquireProcessSlotOptions,
  ) => Promise<ProcessSlotLease | null>;
  slotOptions?: AcquireProcessSlotOptions;
}

function extractPromptText(messages: BaseMessage[]): string {
  // `summarizationMiddleware` always calls `model.invoke(stringPrompt, ...)`
  // — `BaseChatModel.invoke()`'s own `_convertInputToPromptValue` wraps a
  // plain string into exactly one HumanMessage before `_generate` ever sees
  // it (verified against the installed `chat_models.js`). Any other content
  // shape (a multi-message array, or non-string content) is defensively
  // flattened rather than assumed impossible.
  return messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('\n');
}

export class CliSummaryModel extends BaseChatModel {
  constructor(private readonly deps: CliSummaryModelOptions) {
    super({});
  }

  _llmType(): string {
    return 'deus-cli-summary';
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const promptText = extractPromptText(messages);
    const conversationId = `cli-summary-${crypto.randomUUID()}`;

    // LIA-457: reserve a production-wide process slot before spawning — this
    // is a genuinely separate CLI subprocess from any parent conversation
    // that may already hold its own slot. `null` means contention (bounded
    // retries already exhausted, not an infinite wait — see
    // `process-lifecycle-registry.ts`'s `acquireProcessSlot`); this throws
    // rather than spawning anyway, which `summarizationMiddleware`'s own
    // `createSummary()` catches and turns into a recognized failure-shape
    // string that `context-compaction.ts`'s `containsFailedSummary()`
    // already detects — compaction is dropped for this turn (fail open,
    // uncompacted history), never a hang or a leaked process/slot.
    const acquireSlot = this.deps.acquireProcessSlot ?? defaultAcquireProcessSlot;
    const slot = await acquireSlot(this.deps.slotOptions);
    if (slot === null) {
      throw new CliSummaryModelError(
        'CliSummaryModel: no CLI subprocess slot available (production-wide process cap reached)',
      );
    }

    try {
      await this.deps.pool.createConversation(conversationId, {
        scratchDir: this.deps.scratchDirFor(conversationId),
        repoRoot: this.deps.repoRoot,
        model: this.deps.model,
        // mcpServerName/mcpServerScriptPath/allowedTool deliberately omitted
        // — genuinely no-tools, per claude-cli-session-pool.ts's own no-MCP
        // mode (EP-002 step 6).
      });

      try {
        const turnResult = await this.deps.pool.sendTurn(
          conversationId,
          promptText,
        );
        if (
          turnResult.result.is_error ||
          turnResult.result.result === undefined
        ) {
          throw new CliSummaryModelError(
            turnResult.result.result ??
              'CLI summary turn reported is_error with no result text',
          );
        }
        const text = turnResult.result.result;
        return {
          generations: [{ message: new AIMessage(text), text }],
        };
      } finally {
        // Terminate before the parent process is spawned (plan step 3's own
        // requirement) — a one-shot summary conversation never persists past
        // its single call, success or failure.
        await this.deps.pool.terminate(conversationId).catch(() => {});
      }
    } finally {
      slot.release();
    }
  }
}
