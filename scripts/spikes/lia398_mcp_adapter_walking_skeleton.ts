import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatAnthropic } from '@langchain/anthropic';
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { createAgent } from 'langchain';

// Imported rather than re-implemented: this spike NEVER routes through the
// live :3001 daemon — its x-deus-proxy-token auth gate rejects headerless
// requests — so it spawns its own isolated proxy child via A4's reviewed
// mechanism.
import {
  buildProxyRoutedChatAnthropic,
  spawnProxyChild,
  waitForChildReady,
} from './lia397_credential_proxy_billing_spike.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));

export const MCP_X_DIST_PATH = path.join(
  spikeDirectory,
  '..',
  '..',
  'packages',
  'mcp-x',
  'dist',
  'index.js',
);

export interface ToolDiscoveryResult {
  toolNames: string[];
  statusToolFound: boolean;
}

export interface AgentToolInvocationResult {
  succeeded: boolean;
  toolWasCalled: boolean;
  toolResult?: string;
  finalResponse?: string;
  error?: string;
}

export type SpikeAgent = ReturnType<typeof createAgent>;

export type AgentInvokeResult =
  | { succeeded: true; messages: BaseMessage[] }
  | { succeeded: false; error: string };

export type AgentInvoke = (
  agent: SpikeAgent,
  prompt: string,
) => Promise<AgentInvokeResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  // JSON.stringify(undefined) returns runtime `undefined`, not a string —
  // TS's own lib.es5.d.ts types JSON.stringify as always returning `string`
  // (a known gap, unrelated to strict mode), so this can't be caught
  // statically; guard it explicitly instead.
  return JSON.stringify(content) ?? String(content);
}

// Fails loud before any subprocess spawn — a missing build would otherwise
// surface as a cryptic ENOENT from the MCP client's spawned mcp-x child.
export function assertMcpXBuilt(): void {
  if (!existsSync(MCP_X_DIST_PATH)) {
    throw new Error(
      `mcp-x is not built (missing ${MCP_X_DIST_PATH}). Run: ` +
        'cd packages/mcp-channel-core && npm install && npm run build && ' +
        'cd ../mcp-x && npm install && npm run build',
    );
  }
}

export function createMcpXClient(): MultiServerMCPClient {
  return new MultiServerMCPClient({
    mcpServers: {
      'mcp-x': {
        transport: 'stdio',
        command: 'node',
        args: [MCP_X_DIST_PATH],
      },
    },
  });
}

export async function discoverTools(
  client: MultiServerMCPClient,
): Promise<DynamicStructuredTool[]> {
  const tools = await client.getTools('mcp-x');
  if (tools.length === 0) {
    throw new Error(
      'mcp-x connected but returned zero tools — expected at least one (e.g. get_status)',
    );
  }
  return tools;
}

export function findStatusTool(
  tools: DynamicStructuredTool[],
): DynamicStructuredTool {
  const tool = tools.find((t) => t.name === 'get_status');
  if (!tool) {
    throw new Error(
      'get_status tool not found among discovered mcp-x tools: ' +
        tools.map((t) => t.name).join(', '),
    );
  }
  return tool;
}

export async function runToolDiscoverySmokeTest(
  client: MultiServerMCPClient,
): Promise<ToolDiscoveryResult> {
  const tools = await discoverTools(client);
  const toolNames = tools.map((t) => t.name);
  let statusToolFound = true;
  try {
    findStatusTool(tools);
  } catch {
    statusToolFound = false;
  }
  return { toolNames, statusToolFound };
}

export const defaultInvoke: AgentInvoke = async (agent, prompt) => {
  try {
    const result = await agent.invoke({
      messages: [{ role: 'user', content: prompt }],
    });
    // createAgent's return type is a generic StateGraph whose shape TS can't
    // narrow through `SpikeAgent = ReturnType<typeof createAgent>` — the
    // runtime shape (a `messages: BaseMessage[]` field) is exactly what
    // A1/A3/A4 already invoke().messages against, just not expressible here
    // without threading createAgent's full generic parameters through.
    return {
      succeeded: true,
      messages: (result as { messages: BaseMessage[] }).messages,
    };
  } catch (error) {
    return { succeeded: false, error: errorMessage(error) };
  }
};

export async function runAgentToolInvocationSmokeTest(
  client: MultiServerMCPClient,
  model: ChatAnthropic,
  invoke: AgentInvoke = defaultInvoke,
): Promise<AgentToolInvocationResult> {
  try {
    const tools = await client.getTools('mcp-x');
    const agent = createAgent({ model, tools });
    const result = await invoke(
      agent,
      'Check whether X credentials are configured and tell me.',
    );
    if (!result.succeeded) {
      return { succeeded: false, toolWasCalled: false, error: result.error };
    }

    // Match by name, not just message type — mcp-x exposes multiple tools
    // (post_tweet, get_my_profile, etc.), so accepting any tool call would
    // let the agent invoke a different tool and still falsely report
    // AC4's "the get_status result was visible to the model" as satisfied.
    const toolMessage = result.messages.find(
      (message) =>
        message.getType() === 'tool' &&
        (message as { name?: string }).name === 'get_status',
    );
    const lastMessage = result.messages[result.messages.length - 1];
    const finalResponse =
      lastMessage !== undefined && lastMessage.getType() === 'ai'
        ? stringifyContent(lastMessage.content)
        : undefined;

    return {
      succeeded: true,
      toolWasCalled: toolMessage !== undefined,
      toolResult:
        toolMessage === undefined
          ? undefined
          : stringifyContent(toolMessage.content),
      finalResponse,
    };
  } catch (error) {
    return {
      succeeded: false,
      toolWasCalled: false,
      error: errorMessage(error),
    };
  }
}

export interface MainDependencies {
  assertMcpXBuilt: typeof assertMcpXBuilt;
  spawnProxyChild: typeof spawnProxyChild;
  waitForChildReady: typeof waitForChildReady;
  createMcpXClient: typeof createMcpXClient;
  buildProxyRoutedChatAnthropic: typeof buildProxyRoutedChatAnthropic;
  runToolDiscoverySmokeTest: typeof runToolDiscoverySmokeTest;
  runAgentToolInvocationSmokeTest: typeof runAgentToolInvocationSmokeTest;
}

export async function main(
  deps: MainDependencies = {
    // packages/mcp-x/dist is gitignored and only built by CI's separate
    // test-packages job (not the root `ci` job this test file runs under),
    // so the real filesystem check must be injectable — a unit test fakes
    // it out rather than requiring a local build just to run in CI.
    assertMcpXBuilt,
    spawnProxyChild,
    waitForChildReady,
    createMcpXClient,
    buildProxyRoutedChatAnthropic,
    runToolDiscoverySmokeTest,
    runAgentToolInvocationSmokeTest,
  },
): Promise<void> {
  deps.assertMcpXBuilt();
  const port = Number(process.env.SPIKE_PROXY_PORT ?? '3099');
  const proxyChild = deps.spawnProxyChild(port);

  try {
    const readiness = await deps.waitForChildReady(proxyChild, 10_000);

    if (readiness.outcome !== 'started' || readiness.authMode !== 'oauth') {
      console.log(
        JSON.stringify(
          {
            phase: 'precondition',
            succeeded: false,
            reason:
              readiness.outcome === 'aborted'
                ? readiness.reason
                : `authMode was ${readiness.authMode}, expected oauth`,
          },
          null,
          2,
        ),
      );
      return;
    }

    const mcpClient = deps.createMcpXClient();

    // The MCP client's cleanup is nested INSIDE the proxy child's so the
    // proxy is still alive when the agent invocation routes its model call
    // through it — sibling try/finally blocks would kill the proxy first
    // and silently break the invocation smoke test. Injectable deps let a
    // test force a mid-flow throw and assert both cleanups still fire, in
    // this order (mcpClient.close() before proxyChild.kill()).
    try {
      const discovery = await deps.runToolDiscoverySmokeTest(mcpClient);
      console.log('Discovery:', JSON.stringify(discovery, null, 2));

      if (!discovery.statusToolFound) {
        console.log(
          JSON.stringify(
            { succeeded: false, reason: 'get_status tool not found' },
            null,
            2,
          ),
        );
        return;
      }

      const model = deps.buildProxyRoutedChatAnthropic(
        `http://127.0.0.1:${port}`,
      );
      const invocation = await deps.runAgentToolInvocationSmokeTest(
        mcpClient,
        model,
      );
      console.log('Invocation:', JSON.stringify(invocation, null, 2));
    } finally {
      await mcpClient.close();
    }
  } finally {
    proxyChild.kill();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('A5 spike failed:', errorMessage(error));
    process.exitCode = 1;
  });
}
