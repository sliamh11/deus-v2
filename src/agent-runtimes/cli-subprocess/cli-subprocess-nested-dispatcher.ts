/**
 * `NestedDispatcher` implementation backed by the CLI-subprocess transport
 * (LIA-454, first production-wiring walking skeleton).
 *
 * A drop-in alternate to `createNestedDispatcher` (`nested-dispatch.ts`) —
 * implements the same `NestedDispatcher` interface, so
 * `buildNestedDispatchTool` (`nested-dispatch-tool.ts`) can use either
 * without any change to its own logic. `nested-dispatch-tool.ts`'s
 * `childPromptFor()` already embeds the output-contract schema instructions
 * into `request.prompt` before either dispatcher ever sees it — this
 * implementation therefore needs no prompt-augmentation of its own; it sends
 * `request.prompt` to the CLI child exactly as received.
 *
 * Lifecycle per `dispatch()` call: `pool.createConversation()` (spawns one
 * fresh `claude` CLI subprocess, registers the `nested-dispatch-mcp-server.ts`
 * MCP server with the marshalled permission/warden/tool-broker context),
 * `pool.sendTurn()` (one turn, no follow-up), then `pool.terminate()` in a
 * `finally` — matching `nested-dispatch.ts`'s own one-shot,
 * no-persistent-state child semantics (§2.5 of the design doc): no
 * checkpointer, no reuse across dispatches, deterministic per-call cleanup
 * rather than idle-timeout-driven reaping.
 */

import {
  extractCandidateOutput,
  validateNestedDispatchRequest,
  type NestedDispatchMetadata,
  type NestedDispatchRequest,
  type NestedDispatchResult,
  type NestedDispatcher,
} from '../nested-dispatch.js';
import { buildTranscriptUsageEvent } from './checkpoint-translation.js';
import type { ClaudeCliSessionPool } from './claude-cli-session-pool.js';
import { appendNestedDispatchUsage } from './nested-dispatch-usage-channel.js';
import {
  extractAssistantModel,
  extractAssistantUsage,
  isAssistantEvent,
} from './stream-json-protocol.js';

export interface CliSubprocessNestedDispatcherDeps {
  pool: ClaudeCliSessionPool;
  /** Absolute path to `nested-dispatch-mcp-server.ts`. */
  mcpServerScriptPath: string;
  mcpServerName: string;
  repoRoot: string;
  /** Isolated per-dispatch scratch working directory. Called once per
   *  `dispatch()` call with the actual `conversationId` (never just
   *  `agentId` — two dispatches sharing an `agentId` in the same turn, e.g.
   *  concurrent siblings under the pool's `maxProcesses` cap, must not share
   *  a scratch dir/mcp-config file; `conversationId` already embeds
   *  `agentId` as a prefix, so callers keying on it get both a unique path
   *  AND the agentId for logging if they want it). The caller decides the
   *  actual path shape (e.g. under a turn-scoped temp dir). */
  scratchDirFor: (conversationId: string) => string;
  /** Comma-separated `mcp__<mcpServerName>__web_search,mcp__<mcpServerName>__web_fetch`. */
  allowedTool: string;
  permissionMode?: string;
  /**
   * Marshalled once per `runTurn()` call at the `deus-native-backend.ts`
   * call site — the SAME `rawPermissionProfile`/`wardenCwd`/
   * `toolBrokerContext` values the parent's own middleware stack uses,
   * never re-derived independently here or inside the spawned MCP server
   * subprocess. Serialized to `DEUS_NESTED_DISPATCH_CONTEXT` for each
   * spawned MCP server (see `nested-dispatch-mcp-server.ts`).
   */
  mcpServerContext: {
    permissionProfile: string | undefined;
    wardenCwd: string;
    toolBrokerContext: {
      cwd: string;
      groupFolder?: string;
      chatJid?: string;
      isControlGroup?: boolean;
    };
    allowedWebFetchHosts: string[];
  };
  /** LIA-460: when provided, this child's usage is appended to the parent's
   *  own nested-dispatch usage side channel (`nested-dispatch-usage-channel.ts`)
   *  so the HOST can fold it into `RunResult.usage`. Omitted entirely => no
   *  fs write of any kind — see that module's own invariant comment. */
  usageScratchDir?: string;
}

let dispatchCounter = 0;

/** Unique-enough per-call conversation id: agentId plus a monotonic counter.
 *  A per-process counter is sufficient for uniqueness within one pool's
 *  lifetime (the only scope a conversation id needs to be unique in) — no
 *  need for `Date.now()`/`Math.random()`'s collision-avoidance-across-
 *  processes guarantees here. */
function nextConversationId(agentId: string): string {
  dispatchCounter += 1;
  return `${agentId}-${dispatchCounter}`;
}

export function createCliSubprocessNestedDispatcher(
  deps: CliSubprocessNestedDispatcherDeps,
): NestedDispatcher {
  return {
    async dispatch<T>(
      request: NestedDispatchRequest<T>,
    ): Promise<NestedDispatchResult<T>> {
      const metadata: NestedDispatchMetadata = {
        agentId: typeof request?.agentId === 'string' ? request.agentId : '',
        model: typeof request?.model === 'string' ? request.model : '',
      };

      const validationFailure = validateNestedDispatchRequest(
        request,
        metadata,
      );
      if (validationFailure !== undefined) return validationFailure;

      const conversationId = nextConversationId(request.agentId);
      let created = false;
      try {
        await deps.pool.createConversation(conversationId, {
          scratchDir: deps.scratchDirFor(conversationId),
          mcpServerName: deps.mcpServerName,
          mcpServerScriptPath: deps.mcpServerScriptPath,
          mcpServerEnv: {
            DEUS_NESTED_DISPATCH_CONTEXT: JSON.stringify(deps.mcpServerContext),
          },
          repoRoot: deps.repoRoot,
          allowedTool: deps.allowedTool,
          permissionMode: deps.permissionMode,
          model: request.model,
        });
        created = true;

        const turnResult = await deps.pool.sendTurn(
          conversationId,
          request.prompt,
        );

        // LIA-460: recorded regardless of the is_error/contract-validation
        // outcome below — a real model call happened and was billed either
        // way, matching the raw-HTTP path's own `onUsage` callback, which
        // records every AIMessage in `child.invoke()`'s result unconditionally.
        if (deps.usageScratchDir !== undefined) {
          for (const event of turnResult.turnEvents) {
            if (!isAssistantEvent(event)) continue;
            const usage = extractAssistantUsage(event);
            if (usage === undefined) continue;
            const eventModel = extractAssistantModel(event);
            appendNestedDispatchUsage(
              deps.usageScratchDir,
              buildTranscriptUsageEvent(usage, eventModel ?? request.model),
            );
          }
        }

        if (
          turnResult.result.is_error ||
          turnResult.result.result === undefined
        ) {
          return {
            status: 'error',
            error: {
              code: 'subagent_execution_failed',
              message:
                turnResult.result.result ??
                'CLI subprocess turn reported is_error with no result text',
            },
            metadata,
          };
        }

        const candidate = extractCandidateOutput(turnResult.result.result);
        const parsed = await request.outputContract.safeParseAsync(candidate);
        if (!parsed.success) {
          return {
            status: 'contract_failure',
            error: {
              code: 'subagent_output_contract_failed',
              message:
                parsed.error.message ??
                'nested dispatch child output failed contract validation',
              ...(parsed.error.issues !== undefined
                ? { issues: parsed.error.issues }
                : {}),
            },
            metadata,
          };
        }

        return {
          status: 'success',
          output: parsed.data as T,
          metadata,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          error: { code: 'subagent_execution_failed', message },
          metadata,
        };
      } finally {
        // Best-effort cleanup — never masks the real result above, and
        // never throws (createConversation may have failed before the
        // pool recorded this id, in which case pool.terminate() is
        // documented as a no-op).
        if (created) {
          await deps.pool.terminate(conversationId).catch(() => {});
        }
      }
    },
  };
}
