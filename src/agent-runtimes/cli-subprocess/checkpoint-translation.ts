/**
 * CLI-turn -> LangGraph-checkpoint translation bridge (LIA-454 EP-002 step 4).
 *
 * Two separate APIs, deliberately: `translateCliTurnResult` is PURE (no I/O,
 * no clock, no saver) — it reduces one CLI turn's exact events into canonical
 * LangChain messages. `persistCliCheckpoint` is STATEFUL — it writes a
 * synthesized checkpoint directly through an existing `BaseCheckpointSaver`,
 * bypassing LangGraph's own internal graph execution (there is no graph
 * running for a CLI-subprocess turn to produce one).
 *
 * This is the design's highest-blast-radius piece (EP-002, both plan-review
 * rounds): a superficially valid SQLite row that LangGraph's own reducer,
 * compaction, or resume machinery cannot correctly interpret is worse than a
 * visible failure. Every checkpoint-shape decision below is grounded in the
 * real installed `@langchain/langgraph-checkpoint`/`-sqlite` source, not
 * assumed from documentation — see EP-002's decision log for the specific
 * lines read.
 *
 * Concurrency: `persistCliCheckpoint`'s own stale-parent re-read is an
 * INVARIANT ASSERTION, not the concurrency mechanism (`SqliteSaver.put()` is
 * a plain `INSERT OR REPLACE` with no compare-before-write). The real
 * cross-process safety is the `thread_id`-keyed exclusive turn lease built in
 * step 9 (`process-lifecycle-registry.ts`) — callers MUST hold that lease for
 * the entire read-translate-persist span; this module has no way to enforce
 * that itself and does not attempt to.
 */

import crypto from 'node:crypto';

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  copyCheckpoint,
  emptyCheckpoint,
  uuid6,
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import {
  extractAssistantMessageId,
  extractAssistantModel,
  extractAssistantText,
  extractAssistantUsage,
  extractToolResultBlocks,
  extractToolResultText,
  extractToolUseBlocks,
  isAssistantEvent,
  isResultEvent,
  isUserEvent,
  normalizeCliUsageToLangChainUsage,
  type CliUsage,
  type StreamJsonEvent,
} from './stream-json-protocol.js';
import type {
  TranscriptToolCall,
  TranscriptUsageEvent,
} from '../transcript-store.js';

export class CliTurnTranslationError extends Error {}

/**
 * Single source of truth for the CliUsage -> TranscriptUsageEvent mapping
 * (LIA-460) — extracted from what this module's own `translateCliTurnResult`
 * already did inline, so the parent's own usage extraction and the
 * nested-dispatch child usage side-channel (`cli-subprocess-nested-
 * dispatcher.ts`) can never drift apart. Deliberately distinct from the
 * FULL `UsageMetadata` built for the AIMessage's own `usage_metadata` field
 * (which additionally carries `input_token_details`) — this only builds the
 * flat, transcript-facing shape.
 */
export function buildTranscriptUsageEvent(
  usage: CliUsage,
  model: string,
): TranscriptUsageEvent {
  const normalized = normalizeCliUsageToLangChainUsage(usage);
  return {
    provider: 'anthropic',
    model,
    inputTokens: normalized.input_tokens,
    outputTokens: normalized.output_tokens,
    totalTokens: normalized.total_tokens,
  };
}

/**
 * Strips exactly the configured `mcp__<serverName>__` prefix and requires the
 * remainder to be a registered parent-catalog tool name. An unknown/built-in
 * tool name fails visibly rather than entering the durable checkpoint under
 * an unaudited name (design §3.1: the parent MCP server's catalog is the
 * only source of truth for what a CLI turn was allowed to call).
 */
export function stripMcpToolPrefix(
  qualifiedName: string,
  mcpServerName: string,
  registeredToolNames: readonly string[],
): string {
  const prefix = `mcp__${mcpServerName}__`;
  if (!qualifiedName.startsWith(prefix)) {
    throw new CliTurnTranslationError(
      `tool name "${qualifiedName}" does not carry the expected MCP prefix "${prefix}"`,
    );
  }
  const bareName = qualifiedName.slice(prefix.length);
  if (!registeredToolNames.includes(bareName)) {
    throw new CliTurnTranslationError(
      `tool name "${bareName}" (from "${qualifiedName}") is not in the ` +
        `registered parent tool catalog: [${registeredToolNames.join(', ')}]`,
    );
  }
  return bareName;
}

export interface TranslateCliTurnResultOptions {
  /** The stable ID `deus-native-backend.ts` mints for this turn's own
   *  HumanMessage — same contract `runTurn()`'s raw-HTTP branch already
   *  uses for current-turn-slice detection. */
  currentTurnMessageId: string;
  prompt: string;
  /** D1/LIA-415 memory-recall context, when the memory layer supplied one
   *  this turn — matches `middleware-stack.ts`'s `new HumanMessage(context)`
   *  shape exactly (appended after the user's own message). */
  recalledMemoryContext?: string;
  /** This turn's own events only (`TurnResult.turnEvents`) — already
   *  sequence-validated by `ClaudeCliSessionPool` before being handed here;
   *  this function does not re-validate. */
  turnEvents: StreamJsonEvent[];
  mcpServerName: string;
  registeredToolNames: readonly string[];
  /** Prior checkpoint's messages, for message-ID collision detection only
   *  (`lifecycle-events.ts`'s repair contract) — never mutated or returned. */
  priorMessages: readonly BaseMessage[];
}

export interface TranslatedTurn {
  /** Exactly this turn's NEW messages, in receipt order — the caller
   *  concatenates these after `priorMessages` before persisting (see
   *  `persistCliCheckpoint`, which does this concatenation itself). */
  messages: BaseMessage[];
  finalAssistantText: string;
  finalAssistantMessageId?: string;
  toolCalls: TranscriptToolCall[];
  usageEvents: TranscriptUsageEvent[];
  /** Hardcoded 'anthropic' — matches `runTurn()`'s own raw-HTTP branch
   *  (single-provider today); becomes a real field once a second provider
   *  path exists. */
  provider: 'anthropic';
  /** The last assistant event's resolved model id, or '' if no assistant
   *  event carried one (never fabricated — callers must treat '' as
   *  "unknown", not silently use it as a real model id). */
  model: string;
}

/**
 * Translates one CLI turn's exact events into canonical LangChain messages.
 * Pure — no I/O, no clock, no saver. Throws `CliTurnTranslationError` on an
 * unaudited tool name; never on a shape it merely doesn't recognize (unknown
 * content-block types are dropped by the underlying `stream-json-protocol.ts`
 * extractors, matching their own established behavior).
 */
export function translateCliTurnResult(
  options: TranslateCliTurnResultOptions,
): TranslatedTurn {
  const messages: BaseMessage[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  const usageEvents: TranscriptUsageEvent[] = [];
  let finalAssistantText = '';
  let finalAssistantMessageId: string | undefined;
  let model = '';

  // Seeded with prior-checkpoint message IDs (the ONLY collision scope the
  // plan specifies) and extended with each new message's own resolved ID as
  // we go, so two CLI-minted IDs colliding with each other WITHIN this same
  // turn are also caught, not just collisions against history.
  const seenIds = new Set<string>();
  for (const message of options.priorMessages) {
    if (message.id !== undefined) seenIds.add(message.id);
  }

  messages.push(
    new HumanMessage({
      id: options.currentTurnMessageId,
      content: options.prompt,
    }),
  );
  seenIds.add(options.currentTurnMessageId);

  if (
    options.recalledMemoryContext !== undefined &&
    options.recalledMemoryContext !== ''
  ) {
    messages.push(new HumanMessage(options.recalledMemoryContext));
  }

  for (const event of options.turnEvents) {
    if (isAssistantEvent(event)) {
      const text = extractAssistantText(event);
      const toolUseBlocks = extractToolUseBlocks(event);
      const usage = extractAssistantUsage(event);
      const eventModel = extractAssistantModel(event);
      if (eventModel !== undefined) model = eventModel;

      // Collision repair (lifecycle-events.ts:216-228's contract): keep the
      // real provider ID whenever possible; mint a fresh one only on an
      // ACTUAL collision, never unconditionally.
      const rawId = extractAssistantMessageId(event);
      const id =
        rawId !== undefined && seenIds.has(rawId) ? crypto.randomUUID() : rawId;
      if (id !== undefined) seenIds.add(id);

      // Stripped/audited exactly once per block, shared by the AIMessage's
      // own tool_calls and the transcript tool-call list — never re-derived,
      // so both views can't drift from each other.
      const auditedToolCalls = toolUseBlocks.map((block) => ({
        id: block.id,
        name: stripMcpToolPrefix(
          block.name,
          options.mcpServerName,
          options.registeredToolNames,
        ),
        input: block.input,
      }));

      messages.push(
        new AIMessage({
          ...(id !== undefined ? { id } : {}),
          content: text,
          ...(auditedToolCalls.length > 0
            ? {
                tool_calls: auditedToolCalls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  args: call.input,
                })),
              }
            : {}),
          ...(usage !== undefined
            ? { usage_metadata: normalizeCliUsageToLangChainUsage(usage) }
            : {}),
        }),
      );

      toolCalls.push(...auditedToolCalls);
      if (usage !== undefined) {
        usageEvents.push(buildTranscriptUsageEvent(usage, eventModel ?? model));
      }
      if (text !== '') {
        finalAssistantText = text;
        finalAssistantMessageId = id;
      }
    }

    if (isUserEvent(event)) {
      for (const block of extractToolResultBlocks(event)) {
        messages.push(
          new ToolMessage({
            content: extractToolResultText(block),
            tool_call_id: block.tool_use_id,
            status: block.is_error === true ? 'error' : 'success',
          }),
        );
      }
    }

    // Validated fallback ONLY — never a duplicate assistant message. Covers
    // the case where the turn's last assistant event carried no text block
    // (e.g. it ended on a tool call) but the terminal result still reports
    // final text.
    if (
      isResultEvent(event) &&
      finalAssistantText === '' &&
      event.result !== undefined
    ) {
      finalAssistantText = event.result;
    }
  }

  return {
    messages,
    finalAssistantText,
    finalAssistantMessageId,
    toolCalls,
    usageEvents,
    provider: 'anthropic',
    model,
  };
}

export interface PersistCliCheckpointOptions {
  saver: BaseCheckpointSaver;
  threadId: string;
  /** The checkpoint tuple read BEFORE this turn started (or `undefined` for
   *  a brand-new thread) — the caller must have read this under the same
   *  held thread-turn lease this write completes under (see the module doc
   *  comment's concurrency note). */
  priorTuple: CheckpointTuple | undefined;
  /** This turn's own new messages only (`TranslatedTurn.messages`) — this
   *  function concatenates them after `priorTuple`'s own message state
   *  itself, so callers never have to reconstruct the full array. */
  newMessages: BaseMessage[];
  /** LIA-457: when provided, used as the base of `fullMessages` INSTEAD of
   *  `priorTuple`'s own stored messages — the caller's compacted baseline.
   *  Checkpoint `id`/`step`/`parents` linkage is unaffected: compaction only
   *  changes the `messages` channel's CONTENT for the next row, it never
   *  forks checkpoint lineage. Omitted ⇒ byte-identical to today's behavior. */
  replacePriorMessages?: BaseMessage[];
}

/**
 * Writes a synthesized checkpoint directly through the saver, bypassing
 * LangGraph's own internal `Pregel` graph execution entirely (there is no
 * graph running for a CLI-subprocess turn). Every checkpoint-shape decision
 * here (channel-version advancement, parent linkage, metadata step/parents)
 * mirrors what `Pregel`'s own loop would have produced for an equivalent
 * graph-authored turn, so a later raw-HTTP turn can resume this row exactly
 * as if a graph had written it.
 */
export async function persistCliCheckpoint(
  options: PersistCliCheckpointOptions,
): Promise<void> {
  const { saver, threadId, priorTuple, newMessages, replacePriorMessages } =
    options;

  // Invariant assertion, not the concurrency mechanism — see module doc
  // comment. Re-reads immediately before put() to catch an uncoordinated
  // writer or lease misuse; the real guard is the caller's held lease.
  const latestTuple = await saver.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: '' },
  });
  const expectedParentId = priorTuple?.checkpoint.id;
  const latestId = latestTuple?.checkpoint.id;
  if (expectedParentId !== latestId) {
    throw new Error(
      `persistCliCheckpoint: stale parent checkpoint for thread "${threadId}" ` +
        `— expected parent ${expectedParentId ?? '(none)'}, found ` +
        `${latestId ?? '(none)'}; refusing to write (lost-update guard). ` +
        `This indicates a missing or misused thread-turn lease, not a ` +
        `transient condition to retry blindly.`,
    );
  }

  const baseCheckpoint: Checkpoint =
    priorTuple !== undefined
      ? copyCheckpoint(priorTuple.checkpoint)
      : emptyCheckpoint();

  // Both casts narrow LangGraph's own intentionally-loose, untyped channel
  // storage (`channel_values`/`channel_versions` are `Record<string, unknown>`
  // — LangGraph itself has no compile-time knowledge of what any one graph's
  // channels contain) down to the shapes THIS module's own writes always
  // produce for the 'messages' channel.
  const priorMessages =
    replacePriorMessages ??
    (priorTuple?.checkpoint.channel_values['messages'] as
      BaseMessage[] | undefined) ??
    [];
  const fullMessages = [...priorMessages, ...newMessages];

  const priorMessagesVersion = priorTuple?.checkpoint.channel_versions[
    'messages'
  ] as number | undefined;
  const nextVersion = saver.getNextVersion(priorMessagesVersion);

  const newCheckpoint: Checkpoint = {
    ...baseCheckpoint,
    id: uuid6(0),
    ts: new Date().toISOString(),
    channel_values: {
      ...baseCheckpoint.channel_values,
      messages: fullMessages,
    },
    channel_versions: {
      ...baseCheckpoint.channel_versions,
      messages: nextVersion,
    },
  };

  const priorStep = priorTuple?.metadata?.step ?? -1;
  const metadata: CheckpointMetadata = {
    source: 'update',
    step: priorStep + 1,
    parents: priorTuple !== undefined ? { '': priorTuple.checkpoint.id } : {},
  };

  const config = {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      ...(priorTuple !== undefined
        ? { checkpoint_id: priorTuple.checkpoint.id }
        : {}),
    },
  };

  // `newVersions` (4th arg): required by `BaseCheckpointSaver`'s abstract
  // signature; `SqliteSaver` itself ignores it and derives version info from
  // `checkpoint.channel_versions` directly (verified against the installed
  // package source) — still passed for interface compliance, matching this
  // repo's own `checkpointer.test.ts` precedent.
  await saver.put(config, newCheckpoint, metadata, { messages: nextVersion });
}
