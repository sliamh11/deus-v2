/**
 * Runs one parent deus-native turn through the CLI-subprocess transport
 * (LIA-454 EP-002 step 10). The transport-neutral sibling of
 * `cli-subprocess-nested-dispatcher.ts`, but for the PARENT loop: spawns
 * exactly one `claude` CLI conversation via `parent-turn-mcp-server.ts`,
 * translates its events into canonical LangChain messages via
 * `checkpoint-translation.ts`, and persists them through the existing
 * `SqliteSaver` checkpointer — never touching LangGraph's own `Pregel` loop
 * (there is no graph running for a CLI-subprocess turn).
 *
 * Checkpoint-before-success invariant: `persistCliCheckpoint` is awaited
 * BEFORE this function can return `{status: 'success'}` — if the write
 * throws, execution falls into the catch block and only an error outcome
 * is possible. A turn can therefore never be reported successful without a
 * durable checkpoint backing it, and never partially-persist either (the
 * write is one `saver.put()` call — see `checkpoint-translation.ts`).
 *
 * Lease + slot acquisition: this runner acquires BOTH the thread-turn lease
 * and a process slot (`process-lifecycle-registry.ts`, step 9) itself,
 * before its own initial checkpoint read — required for THIS transport's
 * correctness regardless of what the raw-HTTP path does. Whether the
 * raw-HTTP path also needs the same thread-turn lease (the design doc's
 * "Chosen approach" text says "acquired by BOTH transports") is a real,
 * separate design question for step 11 to resolve deliberately — it is a
 * behavior change to the already-live raw-HTTP path, not an additive
 * branch, and is NOT assumed or silently decided here either way. See
 * EP-002's decision log.
 *
 * Deliberately returns a plain, transport-neutral outcome — not a
 * `RunResult` — so the caller (`deus-native-backend.ts`, step 11) folds
 * `newMessages` through the SAME `usageCollector`/transcript/event-sink
 * machinery the raw-HTTP branch already uses, rather than duplicating that
 * logic per transport.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseMessage } from '@langchain/core/messages';

import { DEFAULT_NATIVE_MODEL } from '../model-selection.js';
import {
  persistCliCheckpoint,
  translateCliTurnResult,
} from './checkpoint-translation.js';
import type { ClaudeCliSessionPool } from './claude-cli-session-pool.js';
import { CliSummaryModel } from './cli-summary-model.js';
import { readAndClearNestedDispatchUsage } from './nested-dispatch-usage-channel.js';
import { maybeCompactParentHistory } from './parent-turn-compaction.js';
import { serializeParentHistory } from './parent-turn-history.js';
import {
  acquireProcessSlot as defaultAcquireProcessSlot,
  acquireThreadTurnLease as defaultAcquireThreadTurnLease,
  type AcquireLeaseOptions,
  type AcquireProcessSlotOptions,
  type ProcessSlotLease,
  type ThreadTurnLease,
} from './process-lifecycle-registry.js';
import type { TranscriptUsageEvent } from '../transcript-store.js';

const PARENT_TOOL_NAMES = ['web_search', 'web_fetch', 'dispatch_nested_agent'];

export type ParentCliTurnOutcome =
  | {
      status: 'success';
      newMessages: BaseMessage[];
      finalAssistantText: string;
      finalAssistantMessageId?: string;
      model: string;
      provider: 'anthropic';
      /** LIA-460: nested-dispatch child usage this turn, recorded by the
       *  MCP server subprocess and read back via a file-based side channel
       *  — [] when no dispatch happened this turn, never omitted. */
      nestedUsageEvents: TranscriptUsageEvent[];
    }
  | { status: 'error'; error: string };

export interface RunParentTurnOptions {
  threadId: string;
  prompt: string;
  currentTurnMessageId: string;
  recalledMemoryContext?: string;
  model?: string;
  /** Serialized verbatim into `DEUS_PARENT_TURN_CONTEXT` for the spawned
   *  MCP server — see `parent-turn-mcp-server.ts`'s `ParentTurnMcpContext`. */
  mcpServerContext: Record<string, unknown>;
  permissionMode?: string;
}

export interface ParentTurnRunnerDeps {
  pool: ClaudeCliSessionPool;
  /** Absolute path to `parent-turn-mcp-server.ts`. */
  mcpServerScriptPath: string;
  mcpServerName: string;
  repoRoot: string;
  /** Isolated per-turn scratch working directory, called once with the
   *  actual conversation id (mirrors `cli-subprocess-nested-dispatcher.ts`'s
   *  own `scratchDirFor` contract). */
  scratchDirFor: (conversationId: string) => string;
  saver: BaseCheckpointSaver;
  acquireThreadTurnLease?: (
    threadId: string,
    options?: AcquireLeaseOptions,
  ) => Promise<ThreadTurnLease | null>;
  acquireProcessSlot?: (
    options?: AcquireProcessSlotOptions,
  ) => Promise<ProcessSlotLease | null>;
  leaseOptions?: AcquireLeaseOptions;
  slotOptions?: AcquireProcessSlotOptions;
  /** Invoked ONLY for a genuinely new thread (`priorTuple === undefined`),
   *  mirroring the raw-HTTP path's own `isNewSession` lifecycle contract —
   *  never called for a resumed thread. Its result (if any) is folded into
   *  the history envelope alongside prior messages (LIA-454 EP-002 step 11
   *  — `deus-native-backend.ts` supplies `loadSessionOpenContext(...)
   *  .systemMessage`, reused as-is). Omitted => no session-open content,
   *  same as before this fix existed. */
  loadSessionOpenText?: () => Promise<string | undefined>;
}

let conversationCounter = 0;

/** Unique-enough per-call conversation id — a per-process monotonic counter
 *  is sufficient (matches `cli-subprocess-nested-dispatcher.ts`'s own
 *  `nextConversationId` precedent); no need for a real clock/random source
 *  here. */
function nextConversationId(threadId: string): string {
  conversationCounter += 1;
  return `parent-${threadId}-${conversationCounter}`;
}

export async function runParentTurnViaCliSubprocess(
  options: RunParentTurnOptions,
  deps: ParentTurnRunnerDeps,
): Promise<ParentCliTurnOutcome> {
  const acquireLease =
    deps.acquireThreadTurnLease ?? defaultAcquireThreadTurnLease;
  const acquireSlot = deps.acquireProcessSlot ?? defaultAcquireProcessSlot;

  const lease = await acquireLease(options.threadId, deps.leaseOptions);
  if (lease === null) {
    return {
      status: 'error',
      error: `runParentTurnViaCliSubprocess: could not acquire the thread-turn lease for "${options.threadId}" — another turn is already in flight for this thread`,
    };
  }

  try {
    const slot = await acquireSlot(deps.slotOptions);
    if (slot === null) {
      return {
        status: 'error',
        error:
          'runParentTurnViaCliSubprocess: no CLI subprocess slot available (production-wide process cap reached)',
      };
    }

    try {
      const priorTuple = await deps.saver.getTuple({
        configurable: { thread_id: options.threadId, checkpoint_ns: '' },
      });
      // Narrows LangGraph's own intentionally-loose, untyped channel storage
      // down to the shape THIS module's writes always produce — same cast,
      // same rationale, as `checkpoint-translation.ts`'s `persistCliCheckpoint`.
      const priorMessages =
        (priorTuple?.checkpoint.channel_values['messages'] as
          BaseMessage[] | undefined) ?? [];

      // LIA-457: context-compaction dry run — a pure function call, no
      // LangGraph graph/checkpointer/stand-in turn involved (see
      // `parent-turn-compaction.ts`'s module doc comment for why this avoids
      // the fabricated-turn-into-checkpoint risk EP-002 deferred over). Cheap
      // to call unconditionally: below the token threshold this returns
      // `compacted: false` without any model/CLI call. The summary call (when
      // it does fire) reserves its OWN process slot via the SAME injected
      // `acquireSlot` the parent's own conversation uses below — see
      // `cli-summary-model.ts`'s `_generate`.
      const summaryModel = new CliSummaryModel({
        pool: deps.pool,
        model: options.model ?? DEFAULT_NATIVE_MODEL.model,
        repoRoot: deps.repoRoot,
        scratchDirFor: deps.scratchDirFor,
        acquireProcessSlot: acquireSlot,
        slotOptions: deps.slotOptions,
      });
      const compactionResult = await maybeCompactParentHistory(
        priorMessages,
        summaryModel,
      );

      // Mirrors the raw-HTTP path's own `isNewSession` lifecycle contract:
      // session-open content is loaded and injected once, ONLY on a
      // genuinely new thread — never re-loaded on a resumed one.
      const isNewSession = priorTuple === undefined;
      const sessionOpenText = isNewSession
        ? await deps.loadSessionOpenText?.()
        : undefined;

      // LIA-454 EP-002 step 11: the fix for step 10's zero-history bug —
      // prior conversation history (+ session-open context on a new
      // thread) is serialized and delivered via `--append-system-prompt-
      // file`, never as bare/unwrapped text (see `parent-turn-history.ts`'s
      // trust-model doc comment for why the untrusted-content framing
      // matters here specifically). Omitted entirely when there's nothing
      // to say — matching a true no-op, not an empty file.
      const historyText = serializeParentHistory({
        priorMessages: compactionResult.messages,
        ...(sessionOpenText !== undefined ? { sessionOpenText } : {}),
      });

      const conversationId = nextConversationId(options.threadId);
      const allowedTool = PARENT_TOOL_NAMES.map(
        (name) => `mcp__${deps.mcpServerName}__${name}`,
      ).join(',');
      const scratchDir = deps.scratchDirFor(conversationId);
      let historyFilePath: string | undefined;
      if (historyText !== '') {
        fs.mkdirSync(scratchDir, { recursive: true });
        historyFilePath = path.join(scratchDir, 'history.txt');
        fs.writeFileSync(historyFilePath, historyText, { mode: 0o600 });
      }

      let created = false;
      try {
        await deps.pool.createConversation(conversationId, {
          scratchDir,
          mcpServerName: deps.mcpServerName,
          mcpServerScriptPath: deps.mcpServerScriptPath,
          mcpServerEnv: {
            DEUS_PARENT_TURN_CONTEXT: JSON.stringify(options.mcpServerContext),
            // LIA-460: marshals the SAME scratchDir this function already
            // holds to the MCP server subprocess — see
            // `nested-dispatch-usage-channel.ts`'s own doc comment for why
            // this is an explicit env var, not the process's own cwd.
            DEUS_PARENT_SCRATCH_DIR: scratchDir,
          },
          repoRoot: deps.repoRoot,
          allowedTool,
          ...(options.permissionMode !== undefined
            ? { permissionMode: options.permissionMode }
            : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(historyFilePath !== undefined
            ? { appendSystemPromptFile: historyFilePath }
            : {}),
        });
        created = true;

        // LIA-458: the live CLI turn must actually see recalled memory
        // context THIS turn (same-turn parity with the raw-HTTP path's
        // `beforeModel` injection into `state.messages` before that same
        // turn's model call) — appended after the user's own prompt,
        // mirroring `middleware-stack.ts`'s own bare (unwrapped)
        // `HumanMessage` positioning. `options.prompt` itself is left
        // UNCHANGED below (translateCliTurnResult, persisted checkpoint) —
        // only this live string sent to the CLI subprocess is augmented,
        // so the persisted current-turn message stays the real user prompt.
        const livePrompt =
          options.recalledMemoryContext !== undefined &&
          options.recalledMemoryContext !== ''
            ? `${options.prompt}\n\n${options.recalledMemoryContext}`
            : options.prompt;

        const turnResult = await deps.pool.sendTurn(conversationId, livePrompt);
        if (turnResult.result.is_error) {
          return {
            status: 'error',
            error:
              turnResult.result.result ??
              'CLI subprocess turn reported is_error with no result text',
          };
        }

        const translated = translateCliTurnResult({
          currentTurnMessageId: options.currentTurnMessageId,
          prompt: options.prompt,
          ...(options.recalledMemoryContext !== undefined
            ? { recalledMemoryContext: options.recalledMemoryContext }
            : {}),
          turnEvents: turnResult.turnEvents,
          mcpServerName: deps.mcpServerName,
          registeredToolNames: PARENT_TOOL_NAMES,
          // LIA-457: the collision-detection seed must match what will
          // actually coexist in the persisted checkpoint — when compaction
          // fired, that's the compacted baseline, not the raw stale history.
          priorMessages: compactionResult.messages,
        });

        // Checkpoint-before-success invariant: this write must complete
        // before a success outcome is possible — see module doc comment.
        await persistCliCheckpoint({
          saver: deps.saver,
          threadId: options.threadId,
          priorTuple,
          newMessages: translated.messages,
          ...(compactionResult.compacted
            ? { replacePriorMessages: compactionResult.messages }
            : {}),
        });

        // LIA-460: any nested-dispatch child usage the MCP server subprocess
        // recorded this turn via the file-based side channel — [] when no
        // dispatch happened, never omitted (an empty list is a legitimate
        // real state, not a missing value). Populated only on this success
        // path (RunResult.usage only exists on a success RunResult at all —
        // the raw-HTTP path's own `agent.invoke()` throwing likewise never
        // reaches a usage-bearing return). The file itself is ALWAYS cleaned
        // up in the `finally` below regardless of outcome — this read here
        // both consumes the value for the outcome AND performs that
        // cleanup for the success path; the `finally`'s own cleanup call
        // exists for every OTHER path (error, thrown exception) so no
        // orphaned entry can ever bleed into a later turn's read.
        const nestedUsageEvents = readAndClearNestedDispatchUsage(scratchDir);

        return {
          status: 'success',
          newMessages: translated.messages,
          finalAssistantText: translated.finalAssistantText,
          ...(translated.finalAssistantMessageId !== undefined
            ? { finalAssistantMessageId: translated.finalAssistantMessageId }
            : {}),
          model: translated.model,
          provider: translated.provider,
          nestedUsageEvents,
        };
      } finally {
        if (created) {
          await deps.pool.terminate(conversationId).catch(() => {});
        }
        if (historyFilePath !== undefined) {
          try {
            fs.unlinkSync(historyFilePath);
          } catch {
            // already gone
          }
        }
        // LIA-460 (code-review finding): a turn that errors AFTER a nested
        // dispatch already wrote usage would otherwise orphan that file —
        // defensively clear it here on every path, not just the success
        // return above. A no-op (readAndClearNestedDispatchUsage already
        // returns [] and does nothing) when the success path already
        // consumed it, or when no nested dispatch happened this turn.
        readAndClearNestedDispatchUsage(scratchDir);
      }
    } finally {
      slot.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: message };
  } finally {
    lease.release();
  }
}
