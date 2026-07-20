#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing the PARENT deus-native turn's full
 * tool catalog (`web_search`, `web_fetch`, `dispatch_nested_agent`) to a
 * spawned `claude` CLI subprocess (LIA-454 EP-002 step 8).
 *
 * Extends the exact pattern `nested-dispatch-mcp-server.ts` already proved
 * in production (PR #47): a Deus-owned MCP server relocating the
 * permissions/wardens pre-execution gate onto the MCP tool-handler boundary,
 * via the SAME shared `gateAndExecuteMcpTool` (`mcp-tool-gate.ts`, EP-002
 * step 7) — one policy mediator for both catalogs, not two copies.
 *
 * Critical design point, same as the child server: this runs as a SEPARATE
 * PROCESS spawned fresh per parent turn. It has no access to the real
 * turn's `rawPermissionProfile`/`wardenCwd`/`effectiveModels`/etc unless
 * marshalled across the process boundary — `DEUS_PARENT_TURN_CONTEXT` (read
 * once at server-construction time) is that channel. Per the design doc's
 * explicit least-data requirement: the user's prompt, transcript, recalled
 * memory, vault content, chat JID, and group folder are NEVER marshalled
 * into this plaintext MCP config — only the fields dispatch/web-tool
 * execution genuinely need. Missing or malformed context fails CLOSED
 * (every tool call denied) — never falls back to any default/allow-all
 * profile, and an invalid model/provider ref fails server construction
 * before any child can ever spawn.
 *
 * Isolation: NOT imported by `deus-native-model.ts`/`deus-native-backend.ts`
 * — a standalone process entrypoint, invoked only via its own file path
 * (spawned by `ClaudeCliSessionPool` through `--mcp-config`), same posture
 * as `nested-dispatch-mcp-server.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { resolveMiddlewareStackConfig } from '../middleware-stack.js';
import {
  validateNativeModelRef,
  type NativeModelRef,
} from '../model-selection.js';
import { loadAgentSpecs, type LoadedAgentSpec } from '../agent-spec-loader.js';
import { resolveWardenModelAlias } from '../warden-role-models.js';
import {
  buildSafeTools,
  type ToolBrokerContext,
} from '../tool-broker-langchain-adapter.js';
import {
  executeNestedDispatchTool,
  type DispatchNestedAgentToolInput,
  type NestedDispatchToolModelPolicy,
} from '../nested-dispatch-tool.js';
import { gateAndExecuteMcpTool, type McpToolResult } from './mcp-tool-gate.js';
import { ClaudeCliSessionPool } from './claude-cli-session-pool.js';
import { createCliSubprocessNestedDispatcher } from './cli-subprocess-nested-dispatcher.js';

const WEB_SEARCH = 'web_search';
const WEB_FETCH = 'web_fetch';
const DISPATCH_NESTED_AGENT = 'dispatch_nested_agent';

/** Shape of `DEUS_PARENT_TURN_CONTEXT` — built by `deus-native-backend.ts`
 *  (step 11) from the SAME values its own `runTurn()` already resolves.
 *  Deliberately excludes the user prompt, transcript, recalled memory,
 *  vault content, chat JID, and group folder (design doc §3.2's least-data
 *  requirement — none of `web_search`/`web_fetch`/`dispatch_nested_agent`
 *  ever needs them). */
export interface ParentTurnMcpContext {
  permissionProfile: string | null | undefined;
  wardenCwd: string;
  workspaceRoot?: string;
  /** `buildToolBrokerContext(runContext).cwd` — the only `ToolBrokerContext`
   *  field `executeBrokerTool`'s web_search/web_fetch cases actually read
   *  (confirmed by the same ai-eng-warden finding `nested-dispatch-mcp-
   *  server.ts`'s own marshalled context already relies on). */
  safeToolCwd: string;
  allowedWebFetchHosts: string[];
  parentSessionId: string;
  /** Validated at parse time via `validateNativeModelRef` — never trusted
   *  as-received. */
  effectiveModels: {
    main: NativeModelRef;
    roles: Record<string, NativeModelRef>;
  };
  /** The ALREADY-allowlist-filtered production dispatch catalog identifiers
   *  (`PRODUCTION_CHAT_DISPATCHABLE_ROLES` filtering happens once, at the
   *  `deus-native-backend.ts` call site — this subprocess trusts this list
   *  completely and never re-derives or widens it). */
  agentCatalogIds: string[];
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
 * PURE — parses + VALIDATES `DEUS_PARENT_TURN_CONTEXT`. Missing input,
 * unparseable JSON, a shape missing any required field, or an invalid
 * model/provider ref (checked via the same `validateNativeModelRef` the
 * live raw-HTTP path already uses) all return `undefined` — a deny state
 * at the caller, never a partial/best-effort context. Model validation
 * happens HERE, before any tool is ever registered, matching the design
 * doc's "Unknown model/provider values must pass through
 * validateNativeModelRef() before any child spawn" requirement.
 */
export function parseParentTurnContext(
  encoded: string | undefined,
): ParentTurnMcpContext | undefined {
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
    typeof obj.safeToolCwd !== 'string' ||
    !Array.isArray(obj.allowedWebFetchHosts) ||
    !obj.allowedWebFetchHosts.every((h) => typeof h === 'string') ||
    typeof obj.parentSessionId !== 'string' ||
    typeof obj.effectiveModels !== 'object' ||
    obj.effectiveModels === null ||
    !Array.isArray(obj.agentCatalogIds) ||
    !obj.agentCatalogIds.every((id) => typeof id === 'string')
  ) {
    return undefined;
  }
  const effectiveModelsRaw = obj.effectiveModels as Record<string, unknown>;
  let main: NativeModelRef;
  const roles: Record<string, NativeModelRef> = {};
  try {
    main = validateNativeModelRef(effectiveModelsRaw.main);
    const rolesRaw = effectiveModelsRaw.roles;
    if (typeof rolesRaw === 'object' && rolesRaw !== null) {
      for (const [role, ref] of Object.entries(
        rolesRaw as Record<string, unknown>,
      )) {
        roles[role] = validateNativeModelRef(ref);
      }
    }
  } catch {
    // An invalid/unknown model or provider anywhere in the marshalled
    // config fails the WHOLE context closed — never silently drop just
    // the bad entry and proceed with a partially-validated config.
    return undefined;
  }
  return {
    permissionProfile: obj.permissionProfile as string | null | undefined,
    wardenCwd: obj.wardenCwd,
    ...(typeof obj.workspaceRoot === 'string'
      ? { workspaceRoot: obj.workspaceRoot }
      : {}),
    safeToolCwd: obj.safeToolCwd,
    allowedWebFetchHosts: obj.allowedWebFetchHosts as string[],
    parentSessionId: obj.parentSessionId,
    effectiveModels: { main, roles },
    agentCatalogIds: obj.agentCatalogIds as string[],
  };
}

/** Loads `.claude/agents/*.md`, filtered to `context.agentCatalogIds` —
 *  trusts that allowlist completely (it was already filtered against
 *  `PRODUCTION_CHAT_DISPATCHABLE_ROLES` at the marshalling call site) and
 *  never widens it. Matches `deus-native-backend.ts`'s own
 *  `loadFilteredAgentSpecs()` fail-OPEN posture for this specific concern:
 *  an unrelated malformed spec file must not take down the entire parent
 *  turn's dispatch capability — falls back to an empty catalog and lets
 *  the caller decide whether/how to surface that (unlike the
 *  security-critical permission/model validation above, which fails
 *  CLOSED). */
export function loadFilteredAgentSpecsForParent(
  agentCatalogIds: readonly string[],
): ReadonlyMap<string, LoadedAgentSpec> {
  let all: Map<string, LoadedAgentSpec>;
  try {
    all = loadAgentSpecs();
  } catch (err) {
    console.error(
      'parent-turn-mcp-server: loadAgentSpecs() failed — falling back to ' +
        'an empty nested-dispatch role catalog',
      err,
    );
    return new Map();
  }
  const filtered = new Map<string, LoadedAgentSpec>();
  for (const id of agentCatalogIds) {
    const spec = all.get(id);
    if (spec !== undefined) filtered.set(id, spec);
  }
  return filtered;
}

/** Matches `deus-native-backend.ts`'s own real `resolveEffectiveModelId`
 *  exactly: explicit user role config wins first, then the role's own
 *  checked-in frontmatter `model:` (resolved via the warden alias table),
 *  then the configured main/default. Never throws. */
export function buildModelPolicy(
  context: ParentTurnMcpContext,
  agentSpecs: ReadonlyMap<string, LoadedAgentSpec>,
): NestedDispatchToolModelPolicy {
  return {
    resolveEffectiveModelId: (agentId, _requestedModelId) => {
      if (Object.hasOwn(context.effectiveModels.roles, agentId)) {
        return context.effectiveModels.roles[agentId].model;
      }
      const specModel = agentSpecs.get(agentId)?.model;
      const resolved =
        specModel !== undefined
          ? resolveWardenModelAlias(specModel)
          : undefined;
      if (resolved !== undefined) return resolved;
      // The `roles` branch above already returned when `agentId` has an
      // explicit override, so reaching here always means the fallback is
      // `main` — no need to re-check `hasOwn` (code-review finding: the
      // original ternary duplicated that check and was always dead code).
      return context.effectiveModels.main.model;
    },
  };
}

async function buildWebActions(
  context: ParentTurnMcpContext,
): Promise<
  Record<
    typeof WEB_SEARCH | typeof WEB_FETCH,
    (args: Record<string, unknown>) => Promise<McpToolResult>
  >
> {
  const ctx: ToolBrokerContext = {
    cwd: context.safeToolCwd,
    containerInput: { groupFolder: '', chatJid: '' },
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

  return { [WEB_SEARCH]: invoke(WEB_SEARCH), [WEB_FETCH]: invoke(WEB_FETCH) };
}

/** Dependencies `handleParentTurnToolCall` needs, injected so it is directly
 *  testable with fakes (no real MCP transport, no real subprocess, no real
 *  filesystem) — matching `nested-dispatch-mcp-server.ts`'s own
 *  `handleNestedDispatchToolCall` precedent. */
export interface ParentTurnToolDeps {
  context: ParentTurnMcpContext | undefined;
  middlewareConfig: ReturnType<typeof resolveMiddlewareStackConfig>;
  getWebAction: (
    toolName: typeof WEB_SEARCH | typeof WEB_FETCH,
  ) => Promise<(args: Record<string, unknown>) => Promise<McpToolResult>>;
  getNestedDispatchDeps: () => {
    dispatcher: Parameters<typeof executeNestedDispatchTool>[1]['dispatcher'];
    modelPolicy: NestedDispatchToolModelPolicy;
    agentSpecs: ReadonlyMap<string, LoadedAgentSpec>;
  };
}

/**
 * The permission + wardens pre-execution gate shared by all three tools —
 * exported and directly testable, proving the enforcement decision is made
 * BEFORE any real action (a web fetch, or nested-dispatch child-process
 * construction) is ever invoked, never observed or corrected after the
 * fact. `getNestedDispatchDeps()` is called ONLY from inside
 * `gateAndExecuteMcpTool`'s `realAction` callback — i.e. only after both the
 * permissions and wardens layers already allowed — so a `read-only`-denied
 * `dispatch_nested_agent` call never constructs a nested pool, a CLI
 * subprocess, or even loads agent specs from disk.
 */
export async function handleParentTurnToolCall(
  toolName: typeof WEB_SEARCH | typeof WEB_FETCH | typeof DISPATCH_NESTED_AGENT,
  args: Record<string, unknown>,
  deps: ParentTurnToolDeps,
): Promise<McpToolResult> {
  if (deps.context === undefined) {
    return denyResult(
      toolName,
      'missing or malformed DEUS_PARENT_TURN_CONTEXT at MCP server startup',
    );
  }
  const context = deps.context;

  return gateAndExecuteMcpTool(
    toolName,
    args,
    {
      permissionProfile: context.permissionProfile,
      wardenCwd: context.wardenCwd,
      ...(context.workspaceRoot !== undefined
        ? { workspaceRoot: context.workspaceRoot }
        : {}),
    },
    deps.middlewareConfig,
    async (a) => {
      if (toolName === WEB_SEARCH || toolName === WEB_FETCH) {
        const action = await deps.getWebAction(toolName);
        return action(a);
      }
      const { dispatcher, modelPolicy, agentSpecs } =
        deps.getNestedDispatchDeps();
      const outcome = await executeNestedDispatchTool(
        a as unknown as DispatchNestedAgentToolInput,
        { dispatcher, modelPolicy, agentSpecs },
      );
      if (outcome.kind === 'success') {
        return { content: [{ type: 'text', text: outcome.text }] };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: outcome.content }],
      };
    },
  );
}

/** Builds the MCP server with all three tools registered. Separated from
 *  the transport-connection side effect below so tests can construct it
 *  without starting stdio. Reads `DEUS_PARENT_TURN_CONTEXT`/builds its
 *  nested-dispatch pool ONCE, at construction time — matching the real
 *  subprocess lifecycle (one fresh env/pool per spawn, torn down on
 *  shutdown). */
export function createParentTurnMcpServer(): {
  server: McpServer;
  shutdown: () => Promise<void>;
} {
  const server = new McpServer(
    { name: 'deus_lia454_parent_turn', version: '0.1.0' },
    { capabilities: {} },
  );

  // LIA-454: per-turn permission/warden/tool-broker context, marshalled
  // once at spawn time by parent-turn-runner.ts (never persisted, never
  // logged) — see the module docstring for the full trust model.
  const encodedContext = process.env.DEUS_PARENT_TURN_CONTEXT;
  const context = parseParentTurnContext(encodedContext);
  const middlewareConfig = resolveMiddlewareStackConfig();
  // LIA-460: the SAME scratch directory parent-turn-runner.ts already holds,
  // marshalled via the same mcpServerEnv channel DEUS_PARENT_TURN_CONTEXT
  // uses — see `nested-dispatch-usage-channel.ts`'s doc comment for why this
  // is an explicit env var, not this process's own cwd. Absent => no usage
  // side channel for this turn (the dispatcher's own `usageScratchDir` dep
  // stays undefined, a no-op, never a hard failure).
  const parentScratchDir = process.env.DEUS_PARENT_SCRATCH_DIR;

  // Lazily built and memoized — a denied context never touches any of
  // this (the shared gate returns before realAction is ever called), so
  // an invalid/missing context never pays buildSafeTools()'s or the
  // nested pool's construction cost.
  let webActionsPromise: ReturnType<typeof buildWebActions> | undefined;
  let nestedPool: ClaudeCliSessionPool | undefined;
  let agentSpecs: ReadonlyMap<string, LoadedAgentSpec> | undefined;

  const deps: ParentTurnToolDeps = {
    context,
    middlewareConfig,
    getWebAction: async (toolName) => {
      if (context === undefined) {
        throw new Error('unreachable: gated before context is used');
      }
      webActionsPromise ??= buildWebActions(context);
      return (await webActionsPromise)[toolName];
    },
    getNestedDispatchDeps: () => {
      if (context === undefined) {
        throw new Error('unreachable: gated before context is used');
      }
      agentSpecs ??= loadFilteredAgentSpecsForParent(context.agentCatalogIds);
      nestedPool ??= new ClaudeCliSessionPool({
        // Same bounded mitigation as the nested-dispatch walking skeleton
        // (design doc §3.5's full cross-process registry is EP-002 step 9,
        // built and wired before this parent path goes to production).
        maxProcesses: 3,
        idleTimeoutMs: 120_000,
        terminationGraceMs: 3_000,
        onEvent: () => {},
      });
      // This file's own directory (`cli-subprocess/`) is where
      // `nested-dispatch-mcp-server.ts` also lives — both are stable
      // relative to this file's location on disk (via `import.meta.url`),
      // regardless of this subprocess's own `cwd` (a scratch dir, per
      // `createConversation`'s own `cwd: scratchDir`). `repoRoot` is 3
      // levels up (`cli-subprocess/` -> `agent-runtimes/` -> `src/` -> repo
      // root) — needed only to resolve the `tsx` loader, same as every
      // other `createCliSubprocessNestedDispatcher` caller.
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(thisDir, '..', '..', '..');
      const dispatcher = createCliSubprocessNestedDispatcher({
        pool: nestedPool,
        mcpServerScriptPath: path.join(
          thisDir,
          'nested-dispatch-mcp-server.ts',
        ),
        mcpServerName: 'deus_lia454_nested_dispatch',
        repoRoot,
        // os.tmpdir(), not a path inside the repo tree — matches the
        // established nested-dispatch scratch-dir precedent
        // (`deus-native-backend.ts`'s own `cliSubprocessCreateDispatcher`).
        scratchDirFor: (conversationId) =>
          path.join(
            os.tmpdir(),
            'deus-lia454-parent-nested-dispatch',
            context.parentSessionId,
            conversationId,
          ),
        allowedTool:
          'mcp__deus_lia454_nested_dispatch__web_search,' +
          'mcp__deus_lia454_nested_dispatch__web_fetch',
        mcpServerContext: {
          permissionProfile: context.permissionProfile ?? undefined,
          wardenCwd: context.wardenCwd,
          toolBrokerContext: { cwd: context.safeToolCwd },
          allowedWebFetchHosts: context.allowedWebFetchHosts,
        },
        ...(parentScratchDir !== undefined
          ? { usageScratchDir: parentScratchDir }
          : {}),
      });
      return {
        dispatcher,
        modelPolicy: buildModelPolicy(context, agentSpecs),
        agentSpecs,
      };
    },
  };

  server.tool(
    WEB_SEARCH,
    'Search the web using DuckDuckGo HTML results and return the top hits.',
    { query: z.string().describe('The search query.') },
    async (args) => handleParentTurnToolCall(WEB_SEARCH, args, deps),
  );

  server.tool(
    WEB_FETCH,
    'Fetch a web page and return its text content.',
    { url: z.string().describe('The URL to fetch.') },
    async (args) => handleParentTurnToolCall(WEB_FETCH, args, deps),
  );

  server.tool(
    DISPATCH_NESTED_AGENT,
    'Dispatches a nested, isolated Deus subagent to perform a self-contained ' +
      'task. Every dispatch must declare an explicit output contract (a ' +
      'named JSON Schema) unless targeting a known specialized role.',
    {
      agentId: z.string(),
      model: z.string(),
      prompt: z.string(),
      outputContract: z.object({
        name: z.string(),
        description: z.string().optional(),
        schema: z.record(z.string(), z.unknown()),
      }),
    },
    async (args) => handleParentTurnToolCall(DISPATCH_NESTED_AGENT, args, deps),
  );

  const shutdown = async (): Promise<void> => {
    await nestedPool?.shutdownAll();
  };

  return { server, shutdown };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const { server, shutdown } = createParentTurnMcpServer();
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
