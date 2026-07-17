/**
 * Behavioral proofs for LIA-421's concurrent SubAgent dispatch primitive.
 * These tests use B8's real nested dispatcher where possible and reserve a
 * hand-rolled rejecting dispatcher for the outer-promise failure gap that B8
 * itself cannot represent as a returned result.
 */

import { FakeToolCallingModel } from 'langchain';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SPEC_OUTPUT_CONTRACT,
  buildAgentSpecDispatchRequest,
  loadAgentSpecs,
  type AgentSpecDispatchOutput,
} from './agent-spec-loader.js';
import {
  createNestedDispatcher,
  type NestedDispatcher,
  type NestedDispatchRequest,
  type NestedDispatchResult,
} from './nested-dispatch.js';
import { dispatchSubAgents, type SubAgentTask } from './subagent-dispatch.js';

interface TimingWindow {
  enteredAt?: number;
  exitedAt?: number;
}

function modelReturningAfter(
  content: string,
  delayMs = 0,
  timing?: TimingWindow,
  onComplete?: () => void,
): FakeToolCallingModel {
  const decorate = (model: FakeToolCallingModel): FakeToolCallingModel => {
    const originalGenerate = model._generate.bind(model);
    model._generate = async (
      ...args: Parameters<FakeToolCallingModel['_generate']>
    ) => {
      if (timing) timing.enteredAt = performance.now();
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const result = await originalGenerate(...args);
      const generation = result.generations[0];
      if (generation) {
        generation.text = content;
        generation.message.content = content;
      }
      if (timing) timing.exitedAt = performance.now();
      onComplete?.();
      return result;
    };

    const originalBindTools = model.bindTools.bind(model);
    model.bindTools = (
      ...args: Parameters<FakeToolCallingModel['bindTools']>
    ) => {
      const bound = originalBindTools(...args);
      return bound instanceof FakeToolCallingModel ? decorate(bound) : bound;
    };
    return model;
  };

  return decorate(new FakeToolCallingModel({ toolCalls: [[]] }));
}

function request(
  agentId: string,
  model: string,
  prompt: string,
): NestedDispatchRequest<AgentSpecDispatchOutput> {
  return {
    agentId,
    model,
    prompt,
    outputContract: AGENT_SPEC_OUTPUT_CONTRACT,
  };
}

describe('dispatchSubAgents', () => {
  it('runs independent B8 dispatches concurrently with overlapping model calls', async () => {
    const delayMs = 60;
    const timingByModel = new Map<string, TimingWindow>([
      ['model-a', {}],
      ['model-b', {}],
    ]);
    const dispatcher = createNestedDispatcher({
      resolveModel: (model) =>
        modelReturningAfter(
          JSON.stringify({ content: `result from ${model}` }),
          delayMs,
          timingByModel.get(model),
        ),
    });
    const tasks: SubAgentTask<AgentSpecDispatchOutput>[] = [
      { role: 'first', request: request('agent-a', 'model-a', 'task a') },
      { role: 'second', request: request('agent-b', 'model-b', 'task b') },
    ];

    const batchStartedAt = performance.now();
    const outcomes = await dispatchSubAgents(dispatcher, tasks);
    const elapsedMs = performance.now() - batchStartedAt;

    const first = timingByModel.get('model-a')!;
    const second = timingByModel.get('model-b')!;
    expect(first.enteredAt).toBeDefined();
    expect(first.exitedAt).toBeDefined();
    expect(second.enteredAt).toBeDefined();
    expect(second.exitedAt).toBeDefined();
    expect(Math.max(first.enteredAt!, second.enteredAt!)).toBeLessThan(
      Math.min(first.exitedAt!, second.exitedAt!),
    );
    expect(elapsedMs).toBeLessThan(delayMs * 1.75);
    expect(outcomes.map(({ result }) => result.status)).toEqual([
      'success',
      'success',
    ]);
  });

  it('preserves input order when completion order is different', async () => {
    const delays = new Map([
      ['model-slow', 90],
      ['model-fast', 10],
      ['model-medium', 45],
    ]);
    const completionOrder: string[] = [];
    const dispatcher = createNestedDispatcher({
      resolveModel: (model) =>
        modelReturningAfter(
          JSON.stringify({ content: `${model} result` }),
          delays.get(model)!,
          undefined,
          () => completionOrder.push(model),
        ),
    });
    const tasks: SubAgentTask<AgentSpecDispatchOutput>[] = [
      {
        role: 'slow-role',
        request: request('slow-agent', 'model-slow', 'slow task'),
      },
      {
        role: 'fast-role',
        request: request('fast-agent', 'model-fast', 'fast task'),
      },
      {
        role: 'medium-role',
        request: request('medium-agent', 'model-medium', 'medium task'),
      },
    ];

    const outcomes = await dispatchSubAgents(dispatcher, tasks);

    expect(completionOrder).toEqual([
      'model-fast',
      'model-medium',
      'model-slow',
    ]);
    expect(
      outcomes.map(({ index, role, agentId, requestedModel }) => ({
        index,
        role,
        agentId,
        requestedModel,
      })),
    ).toEqual([
      {
        index: 0,
        role: 'slow-role',
        agentId: 'slow-agent',
        requestedModel: 'model-slow',
      },
      {
        index: 1,
        role: 'fast-role',
        agentId: 'fast-agent',
        requestedModel: 'model-fast',
      },
      {
        index: 2,
        role: 'medium-role',
        agentId: 'medium-agent',
        requestedModel: 'model-medium',
      },
    ]);
  });

  it('isolates a rejecting dispatcher call and leaves sibling results untouched', async () => {
    const firstRequest = request('agent-one', 'model-one', 'first task');
    const failingRequest = request('agent-broken', 'model-broken', 'break');
    const thirdRequest = request('agent-three', 'model-three', 'third task');
    const firstResult: NestedDispatchResult<AgentSpecDispatchOutput> = {
      status: 'success',
      output: { content: 'first result' },
      metadata: { agentId: 'agent-one', model: 'resolved-one' },
    };
    const thirdResult: NestedDispatchResult<AgentSpecDispatchOutput> = {
      status: 'success',
      output: { content: 'third result' },
      metadata: { agentId: 'agent-three', model: 'resolved-three' },
    };
    const started: string[] = [];
    const dispatch = vi.fn(
      async (
        candidate: NestedDispatchRequest<AgentSpecDispatchOutput>,
      ): Promise<NestedDispatchResult<AgentSpecDispatchOutput>> => {
        started.push(candidate.agentId);
        if (candidate === failingRequest) {
          throw new Error('usage observer rejected');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return candidate === firstRequest ? firstResult : thirdResult;
      },
    );
    const dispatcher: NestedDispatcher = {
      dispatch: dispatch as NestedDispatcher['dispatch'],
    };

    const outcomes = await dispatchSubAgents(dispatcher, [
      { role: 'one', request: firstRequest },
      { role: 'broken-role', request: failingRequest },
      { role: 'three', request: thirdRequest },
    ]);

    expect(started).toEqual(['agent-one', 'agent-broken', 'agent-three']);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(outcomes[0].result).toBe(firstResult);
    expect(outcomes[2].result).toBe(thirdResult);
    expect(outcomes[1]).toEqual({
      index: 1,
      role: 'broken-role',
      agentId: 'agent-broken',
      requestedModel: 'model-broken',
      result: {
        status: 'error',
        error: {
          code: 'subagent_execution_failed',
          message: 'usage observer rejected',
        },
        metadata: { agentId: 'agent-broken', model: 'model-broken' },
      },
    });
  });

  it('composes real researcher role specs with B8 into distinct ordered outcomes', async () => {
    const researcher = loadAgentSpecs().get('researcher');
    expect(researcher).toBeDefined();
    const requests = [
      buildAgentSpecDispatchRequest(
        researcher!,
        'Research the first delegated question.',
      ),
      buildAgentSpecDispatchRequest(
        researcher!,
        'Research the second delegated question.',
      ),
    ];
    expect(requests[0].outputContract).toBe(AGENT_SPEC_OUTPUT_CONTRACT);
    expect(requests[1].outputContract).toBe(AGENT_SPEC_OUTPUT_CONTRACT);

    let responseNumber = 0;
    const dispatcher = createNestedDispatcher({
      resolveModel: () => {
        responseNumber += 1;
        return modelReturningAfter(
          JSON.stringify({ content: `research result ${responseNumber}` }),
        );
      },
    });

    const outcomes = await dispatchSubAgents(dispatcher, [
      { role: 'research-track-one', request: requests[0] },
      { role: 'research-track-two', request: requests[1] },
    ]);

    expect(
      outcomes.map(({ index, role, agentId, requestedModel }) => ({
        index,
        role,
        agentId,
        requestedModel,
      })),
    ).toEqual([
      {
        index: 0,
        role: 'research-track-one',
        agentId: 'researcher',
        requestedModel: requests[0].model,
      },
      {
        index: 1,
        role: 'research-track-two',
        agentId: 'researcher',
        requestedModel: requests[1].model,
      },
    ]);
    expect(outcomes[0].result).toMatchObject({
      status: 'success',
      output: { content: 'research result 1' },
    });
    expect(outcomes[1].result).toMatchObject({
      status: 'success',
      output: { content: 'research result 2' },
    });
  });
});
