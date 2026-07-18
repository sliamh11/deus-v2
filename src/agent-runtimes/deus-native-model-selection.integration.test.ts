import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeToolCallingModel } from 'langchain';

import type { ContainerRuntimeDeps } from './container-backend.js';
import type { RuntimeEvent } from './types.js';

const harness = vi.hoisted(() => ({
  checkpoint: '',
  groups: '',
  trace: [] as string[],
  parentSawNestedResult: false,
  // The parent's own model id for this test run — the createAgent mock
  // below uses this (not a hardcoded literal) to decide whether a given
  // createAgent() call is building the parent or one of its dispatched
  // children, so each test can freely choose a main model distinct from
  // whatever role/frontmatter model(s) it expects a child to resolve to.
  mainModel: 'claude-opus-4-8',
  // LIA-411: the scripted parent's dispatch_nested_agent tool calls, one
  // per sequential round (each round's tool result is fed back before the
  // next round fires) — generalized from the original single hardcoded
  // `agentId: 'researcher'` dispatch so a test can script the parent
  // dispatching two DIFFERENT named agents.
  dispatchPlan: [] as Array<{ agentId: string; model: string }>,
}));

function dispatchToolCall(
  id: string,
  plan: { agentId: string; model: string },
) {
  return {
    name: 'dispatch_nested_agent',
    id,
    args: {
      agentId: plan.agentId,
      model: plan.model,
      prompt: 'return a summary',
      outputContract: {
        name: 'summary',
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
      },
    },
  };
}

function decorate(
  model: FakeToolCallingModel,
  modelId: string,
  content?: string,
): FakeToolCallingModel {
  const originalGenerate = model._generate.bind(model);
  model._generate = async (
    ...args: Parameters<FakeToolCallingModel['_generate']>
  ) => {
    harness.trace.push(modelId);
    if (JSON.stringify(args[0]).includes('nested-dispatch-output'))
      harness.parentSawNestedResult = true;
    const result = await originalGenerate(...args);
    if (content !== undefined && result.generations[0]) {
      result.generations[0].text = content;
      result.generations[0].message.content = content;
    }
    return result;
  };
  const originalBindTools = model.bindTools.bind(model);
  model.bindTools = (
    ...args: Parameters<FakeToolCallingModel['bindTools']>
  ) => {
    const bound = originalBindTools(...args);
    return bound instanceof FakeToolCallingModel
      ? decorate(bound, modelId, content)
      : bound;
  };
  return model;
}

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  return {
    ...actual,
    createAgent: (config: Parameters<typeof actual.createAgent>[0]) => {
      const modelId = (config.model as { model?: string }).model ?? 'unknown';
      const isParent = modelId === harness.mainModel;
      const scripted = isParent
        ? decorate(
            new actual.FakeToolCallingModel({
              // One dispatch round per scripted plan entry, then a final
              // empty round with no tool calls so the parent finalizes.
              toolCalls: [
                ...harness.dispatchPlan.map((plan, i) => [
                  dispatchToolCall(`dispatch-${i + 1}`, plan),
                ]),
                [],
              ],
            }),
            modelId,
          )
        : decorate(
            new actual.FakeToolCallingModel({ toolCalls: [[]] }),
            modelId,
            '{"summary":"role model ran"}',
          );
      return actual.createAgent({ ...config, model: scripted });
    },
  };
});

vi.mock('./checkpointer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./checkpointer.js')>();
  return {
    ...actual,
    getCheckpointer: () => actual.getCheckpointer(harness.checkpoint),
  };
});
vi.mock('../group-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../group-folder.js')>();
  return {
    ...actual,
    resolveGroupFolderPath: (folder: string) =>
      path.join(harness.groups, folder),
  };
});
vi.mock('../credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key' as const,
}));
vi.mock('../group-tokens.js', () => ({
  getOrCreateGroupToken: () => 'fake-token',
}));
vi.mock('./tool-broker-langchain-adapter.js', () => ({
  buildSafeTools: async () => [],
}));
// LIA-411: wraps (never replaces) the real parser so the cache test below
// can count invocations, while every other test in this file still gets
// the real frontmatter/YAML parsing behavior against the repo's actual
// `.claude/agents/*.md` files.
vi.mock('../frontmatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../frontmatter.js')>();
  return {
    ...actual,
    extractFrontmatter: vi.fn(actual.extractFrontmatter),
  };
});

const { createDeusNativeRuntime } = await import('./deus-native-backend.js');
const { _resetCheckpointerForTests } = await import('./checkpointer.js');
const { loadWardenRoleModels } = await import('./warden-role-models.js');
const { extractFrontmatter } = await import('../frontmatter.js');

const deps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => {},
};
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-model-selection-'));
  harness.checkpoint = path.join(dir, 'checkpoint.db');
  harness.groups = path.join(dir, 'groups');
  fs.mkdirSync(harness.groups, { recursive: true });
  harness.trace = [];
  harness.parentSawNestedResult = false;
  harness.mainModel = 'claude-opus-4-8';
  harness.dispatchPlan = [];
  _resetCheckpointerForTests();
});
afterEach(() => {
  _resetCheckpointerForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deus-native production model selection', () => {
  it('executes configured role model and never constructs the raw requested model', async () => {
    // LIA-444: uses a synthetic role name ("some-analyst-role") rather than
    // "researcher" — "researcher" is now a catalog-allowlisted role that
    // gets Deus's own real prompt/contract substitution (see the dedicated
    // catalog-mode tests in nested-dispatch.test.ts), so it's no longer a
    // neutral stand-in for testing LIA-411's GENERIC model-selection
    // precedence, which is what this test actually validates. A synthetic
    // name with no real `.claude/agents/*.md` file exercises the exact
    // same `effectiveModels.roles` override path, unaffected by the
    // catalog branch.
    harness.mainModel = 'claude-opus-4-8';
    harness.dispatchPlan = [
      { agentId: 'some-analyst-role', model: 'parent-raw-model-c' },
    ];
    const events: RuntimeEvent[] = [];
    const result = await createDeusNativeRuntime(deps).runTurn(
      {
        prompt: 'delegate research',
        groupFolder: 'g',
        chatJid: 'g@test',
        isControlGroup: false,
        backendConfig: {
          modelSelection: {
            main: { provider: 'anthropic', model: 'claude-opus-4-8' },
            roles: {
              'some-analyst-role': {
                provider: 'anthropic',
                model: 'claude-sonnet-4-6',
              },
            },
          },
        },
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );
    expect(result.status).toBe('success');
    expect(harness.trace).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ]);
    expect(harness.trace).not.toContain('parent-raw-model-c');
    expect(harness.parentSawNestedResult).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'tool_call' && event.name === 'dispatch_nested_agent',
      ),
    ).toBe(true);
  });

  it('resolves plan-reviewer and verification-gate through their own real frontmatter model, discarding the parent-guessed model', async () => {
    // Distinct from BOTH plan-reviewer's (sonnet) and verification-gate's
    // (opus) real `.claude/agents/*.md` frontmatter models, so any
    // `claude-sonnet-4-6`/`claude-opus-4-8` entry in the trace is
    // unambiguously attributable to a dispatched child, never the parent.
    harness.mainModel = 'claude-haiku-4-5-20251001';
    harness.dispatchPlan = [
      { agentId: 'plan-reviewer', model: 'parent-guessed-model-a' },
      { agentId: 'verification-gate', model: 'parent-guessed-model-b' },
    ];
    const events: RuntimeEvent[] = [];
    const result = await createDeusNativeRuntime(deps).runTurn(
      {
        prompt: 'run wardens',
        groupFolder: 'g',
        chatJid: 'g@test',
        isControlGroup: false,
        backendConfig: {
          modelSelection: {
            main: {
              provider: 'anthropic',
              model: 'claude-haiku-4-5-20251001',
            },
            // Deliberately empty: neither name is user-configured here, so
            // the frontmatter tier -- not user config -- is what's under
            // test (the precedence test below covers the opposite case).
            roles: {},
          },
        },
      },
      { backend: 'deus-native', session_id: '' },
      (event) => {
        events.push(event);
      },
    );
    expect(result.status).toBe('success');
    // plan-reviewer.md's real `model: sonnet` frontmatter.
    expect(harness.trace).toContain('claude-sonnet-4-6');
    // verification-gate.md's real `model: opus` frontmatter.
    expect(harness.trace).toContain('claude-opus-4-8');
    expect(harness.trace).not.toContain('parent-guessed-model-a');
    expect(harness.trace).not.toContain('parent-guessed-model-b');
  });

  it('prefers an explicit effectiveModels.roles override over the plan-reviewer frontmatter default', async () => {
    harness.mainModel = 'claude-haiku-4-5-20251001';
    harness.dispatchPlan = [
      { agentId: 'plan-reviewer', model: 'parent-guessed-model-c' },
    ];
    const result = await createDeusNativeRuntime(deps).runTurn(
      {
        prompt: 'run wardens',
        groupFolder: 'g',
        chatJid: 'g@test',
        isControlGroup: false,
        backendConfig: {
          modelSelection: {
            main: {
              provider: 'anthropic',
              model: 'claude-haiku-4-5-20251001',
            },
            roles: {
              // Explicit user override. plan-reviewer.md's real frontmatter
              // still says `model: sonnet` -- the override must win.
              'plan-reviewer': {
                provider: 'anthropic',
                model: 'claude-opus-4-8',
              },
            },
          },
        },
      },
      { backend: 'deus-native', session_id: '' },
      () => {},
    );
    expect(result.status).toBe('success');
    expect(harness.trace).toContain('claude-opus-4-8');
    expect(harness.trace).not.toContain('claude-sonnet-4-6');
    expect(harness.trace).not.toContain('parent-guessed-model-c');
  });
});

describe('loadWardenRoleModels mtime-guard cache', () => {
  it('does not re-parse frontmatter on a second call when no agent file changed', () => {
    const spy = vi.mocked(extractFrontmatter);
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'warden-role-models-cache-'),
    );
    try {
      fs.writeFileSync(
        path.join(cacheDir, 'a.md'),
        '---\nname: a\nmodel: sonnet\n---\nbody',
      );
      const callsBefore = spy.mock.calls.length;

      const first = loadWardenRoleModels(cacheDir);
      expect(first.get('a')).toBe('sonnet');
      const callsAfterFirst = spy.mock.calls.length;
      expect(callsAfterFirst - callsBefore).toBe(1);

      const second = loadWardenRoleModels(cacheDir);
      expect(second).toBe(first);
      expect(spy.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
