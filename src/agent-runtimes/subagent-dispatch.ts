/**
 * Concurrent, application-driven subagent fan-out over B8's unchanged
 * `createNestedDispatcher()` (LIA-421). Design rationale (why not `Send()`,
 * why not implicit `ToolNode` concurrency, why identity is captured before
 * each `await`) lives in `docs/decisions/deus-v2-subagent-dispatch-primitive.md`
 * — not restated here to avoid drift between the two.
 */

import type {
  NestedDispatcher,
  NestedDispatchRequest,
  NestedDispatchResult,
} from './nested-dispatch.js';

/** One application-selected task in a concurrent dispatch batch. */
export interface SubAgentTask<T> {
  /** Batch-local identity; multiple tasks may use the same B8 `agentId`. */
  role: string;
  request: NestedDispatchRequest<T>;
}

/** One totalized task outcome, returned in the task's original input order. */
export interface SubAgentOutcome<T> {
  index: number;
  role: string;
  agentId: string;
  requestedModel: string;
  result: NestedDispatchResult<T>;
}

/**
 * Dispatches a fixed batch concurrently while preserving input order and
 * isolating every task's failure into its own traceable result.
 */
export async function dispatchSubAgents<T>(
  dispatcher: NestedDispatcher,
  tasks: readonly SubAgentTask<T>[],
): Promise<SubAgentOutcome<T>[]> {
  return Promise.all(
    tasks.map(async (task, index): Promise<SubAgentOutcome<T>> => {
      const { role, request } = task;
      const { agentId, model: requestedModel } = request;

      try {
        const result = await dispatcher.dispatch(request);
        return { index, role, agentId, requestedModel, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result: NestedDispatchResult<T> = {
          status: 'error',
          error: { code: 'subagent_execution_failed', message },
          metadata: { agentId, model: requestedModel },
        };
        return { index, role, agentId, requestedModel, result };
      }
    }),
  );
}
