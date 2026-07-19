#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing `web_search`/`web_fetch` to a
 * nested-dispatch child running inside a spawned `claude` CLI subprocess
 * (LIA-454, first production-wiring walking skeleton).
 *
 * Extends the pattern `permission-deny-mcp-server.ts` (§3.1 spike) already
 * verified: an MCP tool's `isError: true` response reaches the CLI's model
 * loop equivalently to today's LangChain `wrapToolCall` -> `ToolMessage`
 * substitution. This server generalizes that verified mechanism into the
 * real production tool catalog nested-dispatch children get today
 * (`buildSafeTools()`'s `web_search`/`web_fetch` — the same two-tool
 * inclusion boundary `tool-broker-langchain-adapter.ts` enforces for the
 * parent's own children).
 *
 * Critical design point: this server runs as a SEPARATE PROCESS spawned
 * fresh per dispatch. It has no access to the parent turn's
 * `rawPermissionProfile`/`wardenCwd`/`ToolBrokerContext` unless those are
 * explicitly marshalled across the process boundary — the
 * `DEUS_NESTED_DISPATCH_CONTEXT` env var (read once at server-construction
 * time) is that channel, built by the `deus-native-backend.ts` call site
 * from the SAME values the parent's own `buildMiddlewareStack`/
 * `buildToolBrokerContext` already compute, never re-derived here. Missing
 * or malformed context fails CLOSED (every tool call denied) — never falls
 * back to any default/allow-all profile.
 *
 * Isolation: NOT imported by `deus-native-model.ts`/`deus-native-backend.ts`
 * — a standalone process entrypoint, invoked only via its own file path
 * (spawned by `ClaudeCliSessionPool` through `--mcp-config`), same posture
 * as `permission-deny-mcp-server.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

import { resolveMiddlewareStackConfig } from '../middleware-stack.js';
import {
  buildSafeTools,
  type ToolBrokerContext,
} from '../tool-broker-langchain-adapter.js';
import { gateAndExecuteMcpTool, type McpToolResult } from './mcp-tool-gate.js';

/** Shape of `DEUS_NESTED_DISPATCH_CONTEXT` — built by `deus-native-backend.ts`
 *  from values already in scope there (see module doc above). */
export interface NestedDispatchMcpContext {
  permissionProfile: string | null | undefined;
  wardenCwd: string;
  toolBrokerContext: {
    cwd: string;
    groupFolder?: string;
    chatJid?: string;
    isControlGroup?: boolean;
  };
  allowedWebFetchHosts: string[];
}

function denyResult(toolName: string, reasonText: string): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `permission_denied: tool "${toolName}" was blocked (${reasonText}). ` +
          `The call was not executed; continue without this tool.`,
      },
    ],
  };
}

/**
 * PURE — parses `DEUS_NESTED_DISPATCH_CONTEXT`. Missing input, unparseable
 * JSON, or a shape missing any required field all return `undefined` — a
 * deny state at the caller, never a partial/best-effort context. Fail
 * closed by construction: there is no code path from "input didn't parse"
 * to "use some default profile".
 */
export function parseNestedDispatchContext(
  encoded: string | undefined,
): NestedDispatchMcpContext | undefined {
  if (encoded === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.wardenCwd !== 'string' ||
    typeof obj.toolBrokerContext !== 'object' ||
    obj.toolBrokerContext === null ||
    !Array.isArray(obj.allowedWebFetchHosts)
  ) {
    return undefined;
  }
  return obj as unknown as NestedDispatchMcpContext;
}

/**
 * The permission + wardens pre-execution gate shared by both `web_search`
 * and `web_fetch`. Exported and directly testable — LIA-454's independent
 * oracle (`nested-dispatch-mcp-server.oracle.test.ts`, authored blind to
 * the original implementation) exercises exactly this function, proving
 * the enforcement decision is made BEFORE `realAction` is ever invoked,
 * never observed or corrected after the fact. Context PARSING stays local
 * (transport/marshalling-specific — see `parseNestedDispatchContext`); the
 * actual policy decision delegates to `mcp-tool-gate.ts`'s transport-neutral
 * `gateAndExecuteMcpTool` (LIA-454 EP-002 step 7), the SAME shared gate the
 * future parent-turn MCP server (step 8) uses, so wardens are now REALLY
 * enforced here (via the shared `runWardenBehavior`) rather than only
 * detected-and-denied — closing the parity gap the original inline
 * implementation left open.
 */
export async function handleNestedDispatchToolCall(
  encodedContext: string | undefined,
  toolName: 'web_search' | 'web_fetch',
  args: Record<string, unknown>,
  realAction: (args: Record<string, unknown>) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  const context = parseNestedDispatchContext(encodedContext);
  if (context === undefined) {
    return denyResult(
      toolName,
      'missing or malformed DEUS_NESTED_DISPATCH_CONTEXT at MCP server startup',
    );
  }

  return gateAndExecuteMcpTool(
    toolName,
    args,
    {
      permissionProfile: context.permissionProfile,
      wardenCwd: context.wardenCwd,
    },
    resolveMiddlewareStackConfig(),
    realAction,
  );
}

/** Builds the real-action delegate for each tool from the existing,
 *  unchanged `buildSafeTools()` implementation — reused, not reimplemented,
 *  including its host-allowlist wrapping and untrusted-content framing. */
async function buildRealActions(
  context: NestedDispatchMcpContext,
): Promise<
  Record<
    'web_search' | 'web_fetch',
    (args: Record<string, unknown>) => Promise<McpToolResult>
  >
> {
  const ctx: ToolBrokerContext = {
    cwd: context.toolBrokerContext.cwd,
    containerInput: {
      groupFolder: context.toolBrokerContext.groupFolder ?? '',
      chatJid: context.toolBrokerContext.chatJid ?? '',
      isControlGroup: context.toolBrokerContext.isControlGroup,
    },
  };
  const tools = await buildSafeTools(ctx, context.allowedWebFetchHosts);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const invoke =
    (name: string) =>
    async (args: Record<string, unknown>): Promise<McpToolResult> => {
      const tool = byName.get(name);
      if (tool === undefined) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${name} is not available` }],
        };
      }
      const result = await tool.invoke(args);
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };
    };

  return {
    web_search: invoke('web_search'),
    web_fetch: invoke('web_fetch'),
  };
}

/** Builds the MCP server with both tools registered. Separated from the
 *  transport-connection side effect below so tests can construct it (or
 *  just call `handleNestedDispatchToolCall` directly) without starting
 *  stdio. Reads `DEUS_NESTED_DISPATCH_CONTEXT` once, at construction time —
 *  matches the real subprocess lifecycle (one fresh env per spawn). */
export function createNestedDispatchMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'deus_lia454_nested_dispatch', version: '0.1.0' },
    { capabilities: {} },
  );

  // LIA-454: marshalled per-turn permission context (see cli-subprocess-nested-dispatcher.ts).
  const encodedContext = process.env.DEUS_NESTED_DISPATCH_CONTEXT; // LIA-454
  const context = parseNestedDispatchContext(encodedContext);
  // Lazily built and memoized — a denied context never touches this (the
  // gate in handleNestedDispatchToolCall returns before realAction is
  // called), so an invalid/missing context never pays buildSafeTools()'s
  // cost.
  let realActionsPromise: ReturnType<typeof buildRealActions> | undefined;
  const getRealAction =
    (name: 'web_search' | 'web_fetch') =>
    async (args: Record<string, unknown>): Promise<McpToolResult> => {
      if (context === undefined) {
        // Unreachable in practice: handleNestedDispatchToolCall's own
        // parseNestedDispatchContext check already denies before this
        // closure is ever invoked. Kept as a defensive fail-closed guard,
        // not a relied-upon path.
        return denyResult(name, 'permission context unavailable');
      }
      realActionsPromise ??= buildRealActions(context);
      const actions = await realActionsPromise;
      return actions[name](args);
    };

  server.tool(
    'web_search',
    'Search the web using DuckDuckGo HTML results and return the top hits.',
    { query: z.string().describe('The search query.') },
    async (args) =>
      handleNestedDispatchToolCall(
        encodedContext,
        'web_search',
        args,
        getRealAction('web_search'),
      ),
  );

  server.tool(
    'web_fetch',
    'Fetch a web page and return its text content.',
    { url: z.string().describe('The URL to fetch.') },
    async (args) =>
      handleNestedDispatchToolCall(
        encodedContext,
        'web_fetch',
        args,
        getRealAction('web_fetch'),
      ),
  );

  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const server = createNestedDispatchMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
