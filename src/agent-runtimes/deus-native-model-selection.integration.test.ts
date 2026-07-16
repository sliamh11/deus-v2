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
}));

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
      const scripted =
        modelId === 'claude-sonnet-4-6'
          ? decorate(
              new actual.FakeToolCallingModel({ toolCalls: [[]] }),
              modelId,
              '{"summary":"role model ran"}',
            )
          : decorate(
              new actual.FakeToolCallingModel({
                toolCalls: [
                  [
                    {
                      name: 'dispatch_nested_agent',
                      id: 'dispatch-1',
                      args: {
                        agentId: 'researcher',
                        model: 'parent-raw-model-c',
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
                    },
                  ],
                  [],
                ],
              }),
              modelId,
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

const { createDeusNativeRuntime } = await import('./deus-native-backend.js');
const { _resetCheckpointerForTests } = await import('./checkpointer.js');

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
  _resetCheckpointerForTests();
});
afterEach(() => {
  _resetCheckpointerForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deus-native production model selection', () => {
  it('executes configured role model and never constructs the raw requested model', async () => {
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
              researcher: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
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
});
