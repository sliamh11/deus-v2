import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createCliSubprocessNestedDispatcher } from './cli-subprocess-nested-dispatcher.js';
import type { ClaudeCliSessionPool } from './claude-cli-session-pool.js';

const OUTPUT_CONTRACT = z.object({ answer: z.string() });

function fakePool(overrides: {
  createConversation?: (
    id: string,
    options: unknown,
  ) => Promise<{ conversationId: string; pid: number }>;
  sendTurn?: (
    id: string,
    prompt: string,
  ) => Promise<{ result: { is_error: boolean; result?: string } }>;
}): {
  pool: ClaudeCliSessionPool;
  terminateCalls: string[];
  createConversationCalls: Array<{ id: string; options: unknown }>;
} {
  const terminateCalls: string[] = [];
  const createConversationCalls: Array<{ id: string; options: unknown }> = [];
  const pool = {
    createConversation: vi.fn(async (id: string, options: unknown) => {
      createConversationCalls.push({ id, options });
      if (overrides.createConversation) {
        return overrides.createConversation(id, options);
      }
      return { conversationId: id, pid: 1 };
    }),
    sendTurn: vi.fn(async (id: string, prompt: string) => {
      if (overrides.sendTurn) return overrides.sendTurn(id, prompt);
      return { result: { is_error: false, result: '{"answer":"ok"}' } };
    }),
    terminate: vi.fn(async (id: string) => {
      terminateCalls.push(id);
    }),
  } as unknown as ClaudeCliSessionPool;
  return { pool, terminateCalls, createConversationCalls };
}

function depsFor(pool: ClaudeCliSessionPool) {
  return {
    pool,
    mcpServerScriptPath: '/repo/nested-dispatch-mcp-server.ts',
    mcpServerName: 'deus_lia454',
    repoRoot: '/repo',
    scratchDirFor: (conversationId: string) => `/tmp/scratch/${conversationId}`,
    allowedTool: 'mcp__deus_lia454__web_search,mcp__deus_lia454__web_fetch',
    mcpServerContext: {
      permissionProfile: 'default',
      wardenCwd: '/repo',
      toolBrokerContext: { cwd: '/repo' },
      allowedWebFetchHosts: [],
    },
  };
}

describe('createCliSubprocessNestedDispatcher: success path', () => {
  it('spawns a conversation, sends the prompt verbatim, validates the parsed result, and terminates', async () => {
    const { pool, terminateCalls, createConversationCalls } = fakePool({});
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: 'do the thing',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.output).toEqual({ answer: 'ok' });
    }
    expect(pool.sendTurn).toHaveBeenCalledWith(
      expect.any(String),
      'do the thing',
    );
    expect(terminateCalls).toHaveLength(1);
    expect(createConversationCalls[0].options).toMatchObject({
      mcpServerEnv: {
        DEUS_NESTED_DISPATCH_CONTEXT: JSON.stringify({
          permissionProfile: 'default',
          wardenCwd: '/repo',
          toolBrokerContext: { cwd: '/repo' },
          allowedWebFetchHosts: [],
        }),
      },
      model: 'claude-sonnet-5',
    });
  });
});

describe('createCliSubprocessNestedDispatcher: contract failure', () => {
  it('returns contract_failure when the CLI result does not match the output contract, and still terminates', async () => {
    const { pool, terminateCalls } = fakePool({
      sendTurn: async () => ({
        result: { is_error: false, result: '{"wrong_field":"x"}' },
      }),
    });
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: 'do the thing',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('contract_failure');
    expect(terminateCalls).toHaveLength(1);
  });
});

describe('createCliSubprocessNestedDispatcher: CLI is_error result', () => {
  it('returns a status:error result when the CLI turn reports is_error, and still terminates', async () => {
    const { pool, terminateCalls } = fakePool({
      sendTurn: async () => ({
        result: { is_error: true, result: 'boom' },
      }),
    });
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: 'do the thing',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('subagent_execution_failed');
      expect(result.error.message).toBe('boom');
    }
    expect(terminateCalls).toHaveLength(1);
  });
});

describe('createCliSubprocessNestedDispatcher: spawn failure', () => {
  it('returns a status:error result when createConversation throws, and does NOT call terminate (never created)', async () => {
    const { pool, terminateCalls } = fakePool({
      createConversation: async () => {
        throw new Error('ENOENT: no claude on PATH');
      },
    });
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: 'do the thing',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.message).toContain('ENOENT');
    }
    expect(terminateCalls).toHaveLength(0);
  });

  it('returns a status:error result when sendTurn throws, and still terminates (conversation was created)', async () => {
    const { pool, terminateCalls } = fakePool({
      sendTurn: async () => {
        throw new Error('subprocess crashed mid-turn');
      },
    });
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: 'do the thing',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('error');
    expect(terminateCalls).toHaveLength(1);
  });
});

describe('createCliSubprocessNestedDispatcher: request validation (reused from nested-dispatch.ts)', () => {
  it('fails closed on a missing prompt before ever touching the pool', async () => {
    const { pool, createConversationCalls } = fakePool({});
    const dispatcher = createCliSubprocessNestedDispatcher(depsFor(pool));

    const result = await dispatcher.dispatch({
      agentId: 'researcher',
      model: 'claude-sonnet-5',
      prompt: '',
      outputContract: OUTPUT_CONTRACT,
    });

    expect(result.status).toBe('contract_failure');
    expect(createConversationCalls).toHaveLength(0);
  });
});
