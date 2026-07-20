#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing LIA-400/A7's benchmark tool set to a
 * spawned `claude` CLI subprocess — the CLI-subprocess leg's tool catalog.
 *
 * Mirrors `parent-turn-mcp-server.ts`'s structure, far simpler: this is
 * benchmark-only code (never imported by any production runtime file), so
 * there is no permission gate, no warden context, no marshalled turn
 * context — just the 8 tools this benchmark's 6 chains need, reusing the
 * SAME framework-agnostic handler functions the LangChain legs' `tool()`
 * wrappers call (`lia400_tool_loop_reliability_benchmark.ts`), so business
 * logic is never duplicated across transports.
 *
 * All 8 tools are always registered; per-chain restriction happens entirely
 * via the CLI's own `--allowedTools` allowlist (same posture
 * `parent-turn-mcp-server.ts` uses for its own 3 tools).
 */

import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import {
  createMcpXClient,
  assertMcpXBuilt,
} from './lia398_mcp_adapter_walking_skeleton.js';
import {
  lookupFact,
  getWeather,
  convertTemperature,
  add,
  multiply,
  createFlakyFetchRecord,
} from './lia400_tool_loop_reliability_benchmark.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(thisDir, '..', '..');

// A fresh OS process spawns per test conversation (matching production's
// real per-conversation MCP server lifecycle), so this module-scope counter
// gives fetch_record a naturally fresh failure counter every chain run —
// same guarantee the original LangChain factory's own doc comment relies on.
const fetchRecord = createFlakyFetchRecord();

let dispatchCounter = 0;
function nextDelegateConversationId(): string {
  dispatchCounter += 1;
  return `lia400-delegate-${dispatchCounter}-${process.pid}`;
}

/**
 * Lazily built and memoized — mirrors `parent-turn-mcp-server.ts`'s own
 * lazy `nestedPool`. Owns exactly one nested `ClaudeCliSessionPool` for the
 * `delegate_to_subagent` tool's sub-conversations, torn down via the
 * `shutdown()` hook below.
 */
let nestedPool: ClaudeCliSessionPool | undefined;
function getNestedPool(): ClaudeCliSessionPool {
  nestedPool ??= new ClaudeCliSessionPool({
    maxProcesses: 3,
    idleTimeoutMs: 120_000,
    terminationGraceMs: 3_000,
    onEvent: () => {},
  });
  return nestedPool;
}

/** Lazily built and memoized, same pattern as `nestedPool` — a thin proxy to
 *  A5's already-reviewed mcp-x client construction, reused unchanged. */
let mcpXClient: ReturnType<typeof createMcpXClient> | undefined;
function getMcpXClient(): ReturnType<typeof createMcpXClient> {
  mcpXClient ??= createMcpXClient();
  return mcpXClient;
}

export function createLia400BenchToolsMcpServer(): {
  server: McpServer;
  shutdown: () => Promise<void>;
} {
  const server = new McpServer(
    { name: 'lia400_bench_tools', version: '0.1.0' },
    { capabilities: {} },
  );

  server.tool(
    'lookup_fact',
    'Looks up a canned fact by topic keyword.',
    { topic: z.string() },
    async (args) => ({
      content: [{ type: 'text', text: await lookupFact(args) }],
    }),
  );

  server.tool(
    'get_weather',
    'Returns the current temperature for a city, in fahrenheit.',
    { city: z.string() },
    async (args) => ({
      content: [{ type: 'text', text: await getWeather(args) }],
    }),
  );

  server.tool(
    'convert_temperature',
    'Converts a temperature value between fahrenheit and celsius.',
    { value: z.number(), from: z.string(), to: z.string() },
    async (args) => ({
      content: [{ type: 'text', text: await convertTemperature(args) }],
    }),
  );

  server.tool(
    'add',
    'Adds two numbers.',
    { a: z.number(), b: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await add(args) }] }),
  );

  server.tool(
    'multiply',
    'Multiplies two numbers.',
    { a: z.number(), b: z.number() },
    async (args) => ({
      content: [{ type: 'text', text: await multiply(args) }],
    }),
  );

  server.tool(
    'fetch_record',
    'Fetches a record by id. The backend is flaky and may report a transient error; retrying the same call succeeds.',
    { id: z.string() },
    async (args) => ({
      content: [{ type: 'text', text: await fetchRecord(args) }],
    }),
  );

  server.tool(
    'get_status',
    'Checks whether X credentials are configured, via the real mcp-x server.',
    {},
    async () => {
      try {
        assertMcpXBuilt();
        const client = getMcpXClient();
        const tools = await client.getTools('mcp-x');
        const statusTool = tools.find((t) => t.name === 'get_status');
        if (statusTool === undefined) {
          return {
            isError: true,
            content: [
              { type: 'text', text: 'get_status not found among mcp-x tools' },
            ],
          };
        }
        const result = await statusTool.invoke({});
        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `get_status failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    'delegate_to_subagent',
    'Delegates a sub-task to a local subagent model.',
    { task: z.string() },
    async (args) => {
      // Same synthetic contract as the raw-HTTP/GPT/Ollama legs' own
      // delegate_to_subagent tool (lia396_provider_override_walking_skeleton.ts)
      // — {task} in, {subagent_answer} out, no tools for the sub — so
      // expectedToolSequence stays identical across every leg. The
      // implementation still exercises the REAL underlying mechanism: a
      // second real `claude` CLI conversation, spawned via the
      // already-supported no-tools mode (mcpServerName/mcpServerScriptPath
      // both omitted — LIA-454 EP-002 step 6), matching production's own
      // Claude-CLI-to-Claude-CLI nested-dispatch shape (there is no "route
      // to Ollama" concept for a spawned CLI subprocess). No-tools means the
      // sub can never call delegate_to_subagent again — bounds the
      // extra-spawn risk to exactly one nested process per call.
      const pool = getNestedPool();
      const conversationId = nextDelegateConversationId();
      const modelId = process.env.DEUS_LIA400_MODEL;
      try {
        await pool.createConversation(conversationId, {
          scratchDir: path.join(
            os.tmpdir(),
            'lia400-cli-subprocess-delegate',
            conversationId,
          ),
          repoRoot: REPO_ROOT,
          ...(modelId !== undefined ? { model: modelId } : {}),
        });
        const turnResult = await pool.sendTurn(conversationId, args.task);
        // code-review finding (mirrors the same fix in the main benchmark
        // runner): preserve the CLI's own reported text on an is_error turn
        // rather than discarding it for a generic constant — the caller
        // (the parent conversation, or a human reading the benchmark log)
        // needs the real reason, not a placeholder.
        const rawResultText = turnResult.result.result ?? '';
        if (turnResult.result.is_error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: rawResultText || 'nested turn reported is_error',
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ subagent_answer: rawResultText }),
            },
          ],
        };
      } finally {
        await pool.terminate(conversationId).catch(() => {});
      }
    },
  );

  const shutdown = async (): Promise<void> => {
    await nestedPool?.shutdownAll();
    await mcpXClient?.close();
  };

  return { server, shutdown };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const { server, shutdown } = createLia400BenchToolsMcpServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const handleShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
  process.stdin.on('close', handleShutdown);

  await server.connect(transport);
}
