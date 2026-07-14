import path from 'node:path';

import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { tool } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  MCP_X_DIST_PATH,
  findStatusTool,
  main,
  runAgentToolInvocationSmokeTest,
  runToolDiscoverySmokeTest,
  type AgentInvoke,
  type MainDependencies,
} from './lia398_mcp_adapter_walking_skeleton.js';

function fakeNamedTools(...names: string[]): DynamicStructuredTool[] {
  return names.map((name) => ({ name })) as unknown as DynamicStructuredTool[];
}

function fakeClient(tools: DynamicStructuredTool[]): {
  client: MultiServerMCPClient;
  getTools: ReturnType<typeof vi.fn>;
} {
  const getTools = vi.fn().mockResolvedValue(tools);
  return { client: { getTools } as unknown as MultiServerMCPClient, getTools };
}

function realStatusTool(): DynamicStructuredTool {
  return tool(async () => 'X credentials: not configured', {
    name: 'get_status',
    description: 'Report whether X credentials are configured.',
    schema: z.object({}),
  }) as DynamicStructuredTool;
}

function placeholderModel(): ChatAnthropic {
  return new ChatAnthropic({
    model: 'claude-opus-4-8',
    apiKey: 'fixture-key-never-sent',
  });
}

describe('MCP_X_DIST_PATH', () => {
  it('resolves to packages/mcp-x/dist/index.js two directories above scripts/spikes', () => {
    expect(path.isAbsolute(MCP_X_DIST_PATH)).toBe(true);
    expect(MCP_X_DIST_PATH).not.toContain('..');
    expect(
      MCP_X_DIST_PATH.endsWith(
        path.join('packages', 'mcp-x', 'dist', 'index.js'),
      ),
    ).toBe(true);
    expect(MCP_X_DIST_PATH).not.toContain(path.join('scripts', 'spikes'));
  });
});

describe('findStatusTool', () => {
  it('locates the get_status tool among discovered tools', () => {
    const tools = fakeNamedTools('post_tweet', 'get_status', 'get_timeline');

    expect(findStatusTool(tools).name).toBe('get_status');
  });

  it('throws an error listing the available tool names when absent', () => {
    const tools = fakeNamedTools('post_tweet', 'get_timeline');

    expect(() => findStatusTool(tools)).toThrow(
      'get_status tool not found among discovered mcp-x tools: post_tweet, get_timeline',
    );
  });
});

describe('runToolDiscoverySmokeTest', () => {
  it('returns the discovered tool names and finds get_status', async () => {
    const { client, getTools } = fakeClient(
      fakeNamedTools('get_status', 'post_tweet'),
    );

    await expect(runToolDiscoverySmokeTest(client)).resolves.toEqual({
      toolNames: ['get_status', 'post_tweet'],
      statusToolFound: true,
    });
    expect(getTools).toHaveBeenCalledWith('mcp-x');
  });

  it('reports statusToolFound false without throwing when get_status is absent', async () => {
    const { client } = fakeClient(fakeNamedTools('post_tweet'));

    await expect(runToolDiscoverySmokeTest(client)).resolves.toEqual({
      toolNames: ['post_tweet'],
      statusToolFound: false,
    });
  });

  it('throws when mcp-x connects but exposes zero tools', async () => {
    const { client } = fakeClient([]);

    await expect(runToolDiscoverySmokeTest(client)).rejects.toThrow(
      'mcp-x connected but returned zero tools',
    );
  });
});

describe('runAgentToolInvocationSmokeTest', () => {
  it('extracts toolWasCalled, toolResult, and finalResponse from the message list', async () => {
    const { client } = fakeClient([realStatusTool()]);
    const invoke: AgentInvoke = vi.fn().mockResolvedValue({
      succeeded: true,
      messages: [
        new HumanMessage(
          'Check whether X credentials are configured and tell me.',
        ),
        new AIMessage('Let me check the status.'),
        new ToolMessage({
          content: 'X credentials: not configured',
          tool_call_id: 'call_1',
          name: 'get_status',
        }),
        new AIMessage('X credentials are not configured.'),
      ],
    });

    await expect(
      runAgentToolInvocationSmokeTest(client, placeholderModel(), invoke),
    ).resolves.toEqual({
      succeeded: true,
      toolWasCalled: true,
      toolResult: 'X credentials: not configured',
      finalResponse: 'X credentials are not configured.',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toBe(
      'Check whether X credentials are configured and tell me.',
    );
  });

  it('reports toolWasCalled false when the agent answered without a tool call', async () => {
    const { client } = fakeClient([realStatusTool()]);
    const invoke: AgentInvoke = vi.fn().mockResolvedValue({
      succeeded: true,
      messages: [
        new HumanMessage(
          'Check whether X credentials are configured and tell me.',
        ),
        new AIMessage('I cannot check that.'),
      ],
    });

    await expect(
      runAgentToolInvocationSmokeTest(client, placeholderModel(), invoke),
    ).resolves.toEqual({
      succeeded: true,
      toolWasCalled: false,
      toolResult: undefined,
      finalResponse: 'I cannot check that.',
    });
  });

  it('reports toolWasCalled false when a different mcp-x tool was called instead of get_status', async () => {
    const { client } = fakeClient([realStatusTool()]);
    const invoke: AgentInvoke = vi.fn().mockResolvedValue({
      succeeded: true,
      messages: [
        new HumanMessage(
          'Check whether X credentials are configured and tell me.',
        ),
        new AIMessage('Let me check your profile.'),
        new ToolMessage({
          content: '{"username": "example"}',
          tool_call_id: 'call_1',
          name: 'get_my_profile',
        }),
        new AIMessage('Your profile is set up.'),
      ],
    });

    await expect(
      runAgentToolInvocationSmokeTest(client, placeholderModel(), invoke),
    ).resolves.toEqual({
      succeeded: true,
      toolWasCalled: false,
      toolResult: undefined,
      finalResponse: 'Your profile is set up.',
    });
  });

  it('normalizes an invocation failure into succeeded false, never throwing', async () => {
    const { client } = fakeClient([realStatusTool()]);
    const invoke: AgentInvoke = vi.fn().mockResolvedValue({
      succeeded: false,
      error: 'model unreachable',
    });

    await expect(
      runAgentToolInvocationSmokeTest(client, placeholderModel(), invoke),
    ).resolves.toEqual({
      succeeded: false,
      toolWasCalled: false,
      error: 'model unreachable',
    });
  });

  it('normalizes a getTools failure into succeeded false, never throwing', async () => {
    const getTools = vi
      .fn()
      .mockRejectedValue(new Error('stdio transport failed'));
    const client = { getTools } as unknown as MultiServerMCPClient;
    const invoke: AgentInvoke = vi.fn();

    await expect(
      runAgentToolInvocationSmokeTest(client, placeholderModel(), invoke),
    ).resolves.toEqual({
      succeeded: false,
      toolWasCalled: false,
      error: 'stdio transport failed',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  function fakeDeps(overrides: Partial<MainDependencies> = {}): {
    deps: MainDependencies;
    killOrder: string[];
  } {
    const killOrder: string[] = [];
    const fakeProxyChild = { kill: () => killOrder.push('proxy') };
    const fakeMcpClient = {
      close: vi.fn(async () => {
        killOrder.push('mcp');
      }),
    };

    const deps: MainDependencies = {
      // Real assertMcpXBuilt requires a local build of packages/mcp-x,
      // which CI's root `ci` job (running this test file) never performs —
      // fake it out so these tests are hermetic regardless of local state.
      assertMcpXBuilt:
        vi.fn() as unknown as MainDependencies['assertMcpXBuilt'],
      spawnProxyChild: vi.fn(
        () => fakeProxyChild,
      ) as unknown as MainDependencies['spawnProxyChild'],
      waitForChildReady: vi.fn(async () => ({
        outcome: 'started' as const,
        authMode: 'oauth',
        usesRefreshableOAuth: false,
      })) as unknown as MainDependencies['waitForChildReady'],
      createMcpXClient: vi.fn(
        () => fakeMcpClient,
      ) as unknown as MainDependencies['createMcpXClient'],
      buildProxyRoutedChatAnthropic: vi.fn(() =>
        placeholderModel(),
      ) as unknown as MainDependencies['buildProxyRoutedChatAnthropic'],
      runToolDiscoverySmokeTest: vi.fn(async () => ({
        toolNames: ['get_status'],
        statusToolFound: true,
      })) as unknown as MainDependencies['runToolDiscoverySmokeTest'],
      runAgentToolInvocationSmokeTest: vi.fn(async () => ({
        succeeded: true,
        toolWasCalled: true,
        toolResult: 'X credentials: not configured',
        finalResponse: 'X credentials are not configured.',
      })) as unknown as MainDependencies['runAgentToolInvocationSmokeTest'],
      ...overrides,
    };
    return { deps, killOrder };
  }

  it('closes the mcp client before killing the proxy child on the happy path', async () => {
    const { deps, killOrder } = fakeDeps();

    await main(deps);

    expect(killOrder).toEqual(['mcp', 'proxy']);
    expect(deps.runAgentToolInvocationSmokeTest).toHaveBeenCalledTimes(1);
  });

  it('still closes both, in order, when discovery throws mid-flow', async () => {
    const { deps, killOrder } = fakeDeps({
      runToolDiscoverySmokeTest: vi
        .fn()
        .mockRejectedValue(
          new Error('stdio transport failed'),
        ) as unknown as MainDependencies['runToolDiscoverySmokeTest'],
    });

    await expect(main(deps)).rejects.toThrow('stdio transport failed');

    expect(killOrder).toEqual(['mcp', 'proxy']);
    expect(deps.runAgentToolInvocationSmokeTest).not.toHaveBeenCalled();
  });

  it('still kills the proxy child when the mcp client was never created (precondition failure)', async () => {
    const { deps, killOrder } = fakeDeps({
      waitForChildReady: vi.fn(async () => ({
        outcome: 'aborted' as const,
        reason: 'credentials near refresh window',
      })) as unknown as MainDependencies['waitForChildReady'],
    });

    await main(deps);

    expect(killOrder).toEqual(['proxy']);
    expect(deps.createMcpXClient).not.toHaveBeenCalled();
  });
});
