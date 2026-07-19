/**
 * LIA-454 EP-002 step 7: focused tests for `executeNestedDispatchTool` —
 * the transport-neutral `dispatch_nested_agent` core extracted from
 * `nested-dispatch-tool.ts`'s LangChain adapter. Proves the core is
 * independently callable/testable with NO LangChain `ToolMessage`/
 * `toolCallId` concept at all (the whole point of the extraction — the
 * future parent-turn MCP server, EP-002 step 8, calls this same function).
 * Complements, never replaces, `nested-dispatch.test.ts`'s existing
 * `buildNestedDispatchTool` coverage (which proves the LangChain adapter
 * still produces the same `ToolMessage`/string shapes it always has).
 */
import { describe, expect, it, vi } from 'vitest';
import { FakeToolCallingModel } from 'langchain';

import { createNestedDispatcher } from './nested-dispatch.js';
import {
  executeNestedDispatchTool,
  type DispatchNestedAgentToolInput,
} from './nested-dispatch-tool.js';
import type { LoadedAgentSpec } from './agent-spec-loader.js';

// Identical to nested-dispatch.test.ts's own helper — the `bindTools`
// override is load-bearing, not incidental: createNestedDispatcher's
// internal agent construction calls `.bindTools()`, which returns a NEW
// model instance that would silently lose the `_generate` patch (and
// therefore the scripted content) without it.
function modelReturning(content: string): FakeToolCallingModel {
  const decorate = (model: FakeToolCallingModel): FakeToolCallingModel => {
    const originalGenerate = model._generate.bind(model);
    model._generate = async (
      ...args: Parameters<FakeToolCallingModel['_generate']>
    ) => {
      const result = await originalGenerate(...args);
      const generation = result.generations[0];
      if (generation) {
        generation.text = content;
        generation.message.content = content;
      }
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

const VALID_CONTRACT = {
  name: 'ok',
  schema: {
    type: 'object',
    properties: { x: { type: 'string' } },
    required: ['x'],
    additionalProperties: false,
  },
};

function baseInput(
  overrides: Partial<DispatchNestedAgentToolInput> = {},
): DispatchNestedAgentToolInput {
  return {
    agentId: 'a',
    model: 'm1',
    prompt: 'do the task',
    outputContract: VALID_CONTRACT,
    ...overrides,
  };
}

describe('executeNestedDispatchTool: transport-neutral outcome shape', () => {
  it('returns {kind:"success", text} on a valid dispatch, with the untrusted-output framing intact', async () => {
    const resolveModel = vi.fn(() =>
      modelReturning(JSON.stringify({ x: 'ok' })),
    );
    const dispatcher = createNestedDispatcher({ resolveModel });

    const outcome = await executeNestedDispatchTool(baseInput(), {
      dispatcher,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.text).toContain('<nested-dispatch-output');
      expect(outcome.text).toContain('untrusted data');
      expect(
        JSON.parse(
          outcome.text.split('\n').find((l) => l.trim().startsWith('{'))!,
        ),
      ).toMatchObject({ status: 'success', output: { x: 'ok' } });
    }
  });

  it('returns {kind:"error", content} for an empty prompt, never invoking the dispatcher at all', async () => {
    const dispatcher = { dispatch: vi.fn() };
    const outcome = await executeNestedDispatchTool(baseInput({ prompt: '' }), {
      dispatcher,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.content).toContain('subagent_output_contract_failed');
    }
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns {kind:"error", content} for an uncompilable outputContract schema, never invoking the dispatcher', async () => {
    const dispatcher = { dispatch: vi.fn() };
    const outcome = await executeNestedDispatchTool(
      baseInput({
        outputContract: { name: 'bad', schema: { type: 'not-a-real-type' } },
      }),
      { dispatcher },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.content).toContain('subagent_output_contract_failed');
    }
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns {kind:"error", content} when the dispatcher itself reports failure (e.g. contract mismatch)', async () => {
    const resolveModel = vi.fn(() => modelReturning('not valid json at all'));
    const dispatcher = createNestedDispatcher({ resolveModel });

    const outcome = await executeNestedDispatchTool(baseInput(), {
      dispatcher,
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      const parsed = JSON.parse(outcome.content);
      expect(parsed.status).not.toBe('success');
    }
  });

  it('a catalog-matched agentId uses the role spec (its own systemPrompt/model/AGENT_SPEC_OUTPUT_CONTRACT), ignoring the caller-supplied model/outputContract', async () => {
    const resolveModel = vi.fn(() =>
      modelReturning(JSON.stringify({ content: 'catalog result' })),
    );
    const dispatcher = createNestedDispatcher({ resolveModel });
    const spec: LoadedAgentSpec = {
      name: 'a',
      description: 'test role',
      model: 'unresolvable-checked-in-alias',
      systemPrompt: 'You are a test role.',
      sourcePath: '/fake/a.md',
      frontmatter: { description: 'test role' },
    };
    const agentSpecs = new Map([['a', spec]]);
    // A real modelPolicy, matching production (LIA-411 always supplies one)
    // — `resolveEffectiveModelId`'s returned value is used AS the
    // `modelOverride` in `buildAgentSpecDispatchRequest`, bypassing
    // `resolveWardenModelAlias` entirely, so the spec's own (deliberately
    // unresolvable) `model` field never needs to resolve as a real alias.
    const modelPolicy = {
      resolveEffectiveModelId: () => 'claude-sonnet-5',
    };

    const outcome = await executeNestedDispatchTool(
      baseInput({
        model: 'ignored-caller-model',
        outputContract: { name: 'ignored', schema: { type: 'object' } },
      }),
      { dispatcher, agentSpecs, modelPolicy },
    );

    expect(outcome.kind).toBe('success');
    expect(resolveModel).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('no toolCallId concept anywhere in the outcome — proves genuine transport neutrality', async () => {
    const resolveModel = vi.fn(() =>
      modelReturning(JSON.stringify({ x: 'ok' })),
    );
    const dispatcher = createNestedDispatcher({ resolveModel });
    const outcome = await executeNestedDispatchTool(baseInput(), {
      dispatcher,
    });
    expect(outcome).not.toHaveProperty('tool_call_id');
    expect(outcome).not.toHaveProperty('toolCallId');
  });
});
