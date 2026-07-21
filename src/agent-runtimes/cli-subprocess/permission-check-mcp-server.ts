#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing exactly one tool, `check_permission`
 * (LIA-449 walking skeleton).
 *
 * Reuses the existing pure permission evaluator
 * (`src/agent-runtimes/permission-rules.ts`) rather than a synthetic echo
 * tool, so the live smoke run exercises Deus's real, reviewed permission
 * semantics end to end over the CLI-subprocess MCP seam.
 *
 * Launched by `ClaudeCliSessionPool` (`claude-cli-session-pool.ts`,
 * `buildMcpScratchConfig`) via an absolute `--import <tsx-loader>` path, not
 * `npx tsx`/a bare specifier — see that module's `resolveTsxLoaderPath` doc
 * comment for why the bare-specifier form fails from the CLI's isolated
 * scratch cwd.
 *
 * Isolation: this module is NOT imported by `deus-native-model.ts`,
 * `deus-native-backend.ts`, or the runtime registry — it is a standalone
 * process entrypoint, invoked only via its own file path.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

import {
  evaluatePermission,
  resolvePermissionProfile,
  type PolicyDecision,
} from '../permission-rules.js';

const PERMISSION_PROFILE_NAME = 'read-only';

export interface CheckPermissionArgs {
  toolName: string;
  probeId: string;
}

/**
 * Structured, model-safe result. Includes the MCP
 * server's own PID solely for the smoke runner's orphan-cleanup
 * verification (phase 6: "assert both the CLI PID and the MCP server PID
 * are gone" after a force-kill) — never used for any policy decision.
 */
export interface CheckPermissionResult {
  probeId: string;
  profile: string;
  toolName: string;
  // The evaluator's full verdict type (widened to include 'ask' by the
  // 2026-07-21 amendment). Under the hardcoded 'read-only' profile this
  // server reports, only 'allow'/'deny' actually occur today — importing
  // PolicyDecision keeps this field compile-correct without new runtime
  // logic (type-compile fix only, per the plan's stated scope).
  decision: PolicyDecision;
  source: 'rule' | 'default';
  matchedRuleIndex: number | undefined;
  reason: string;
  pid: number;
}

/**
 * PURE(ish) — the only non-determinism is `process.pid`, included solely as
 * orphan-cleanup evidence, never consulted by the decision itself. Exported
 * and directly callable so this is testable without spawning any process
 *.
 */
export function handleCheckPermission(
  args: CheckPermissionArgs,
): CheckPermissionResult {
  const policy = resolvePermissionProfile(PERMISSION_PROFILE_NAME);
  const evaluation = evaluatePermission(policy, args.toolName);
  return {
    probeId: args.probeId,
    profile: PERMISSION_PROFILE_NAME,
    toolName: args.toolName,
    decision: evaluation.decision,
    source: evaluation.source,
    matchedRuleIndex: evaluation.matchedRuleIndex,
    reason: evaluation.reason,
    pid: process.pid,
  };
}

/** Builds the MCP server with the one tool registered. Separated from the
 *  transport-connection side effect below so tests can construct it (or
 *  just call `handleCheckPermission` directly) without starting stdio. */
export function createPermissionCheckMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'deus_lia449_check_permission', version: '0.1.0' },
    { capabilities: {} },
  );

  server.tool(
    'check_permission',
    'Evaluates whether a named Deus tool is allowed under the read-only ' +
      'permission profile. Echoes back the given probeId so the caller can ' +
      'confirm this exact result came from this exact call.',
    {
      toolName: z.string().describe('Exact Deus tool name to evaluate.'),
      probeId: z
        .string()
        .describe('Opaque caller-chosen id, echoed back verbatim.'),
    },
    async (args) => {
      const result = handleCheckPermission(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const server = createPermissionCheckMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
