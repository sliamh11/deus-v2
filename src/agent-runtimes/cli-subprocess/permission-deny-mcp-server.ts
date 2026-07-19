#!/usr/bin/env node
/**
 * Standalone stdio MCP server exposing two tools, `deny_probe` and
 * `allow_probe` (LIA-454 §3.1 verification spike, `lia449b`).
 *
 * Structural sibling of `permission-check-mcp-server.ts` (LIA-449), but
 * closes the gap that server's own doc comment flags: `check_permission` is
 * a read-only probe that always returns a normal (non-error) result
 * reporting what the decision *would* be — it never returns a real MCP
 * `isError: true` tool result. This server's `deny_probe` does exactly
 * that, reproducing `middleware-stack.ts`'s `buildPermissionsMiddleware`
 * deny text byte-for-byte (plus a trailing, appended probe-correlation
 * suffix) so `lia449b_mcp_deny_equivalence_spike.ts` can assert whether the
 * `claude` CLI's own model loop receives and respects it equivalently to
 * today's LangChain `wrapToolCall` -> `ToolMessage({status:'error'})` path.
 *
 * Isolation: NOT imported by `deus-native-model.ts`, `deus-native-backend.ts`,
 * or the runtime registry — a standalone process entrypoint, invoked only
 * via its own file path, same posture as `permission-check-mcp-server.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

import {
  evaluatePermission,
  resolvePermissionProfile,
} from '../permission-rules.js';

const PERMISSION_PROFILE_NAME = 'read-only';
const DENY_TOOL_NAME = 'write_file';
const ALLOW_TOOL_NAME = 'web_search';

export interface DenyProbeArgs {
  probeId: string;
}

export interface AllowProbeArgs {
  probeId: string;
}

/**
 * Reproduces `middleware-stack.ts`'s `buildPermissionsMiddleware` deny
 * string byte-for-byte (`middleware-stack.ts:273-276`), substituting
 * `toolName`/`profileName`/the real `evaluation.reason` exactly as that
 * code does, with a trailing `(probeId: <id>)` appended for correlation —
 * the spike script matches this text with `.includes()`, not `===`, so the
 * suffix doesn't weaken the byte-for-byte comparison of the mirrored
 * portion itself.
 */
function buildMirroredDenyText(
  toolName: string,
  profileName: string,
  reason: string,
  probeId: string,
): string {
  return (
    `permission_denied: tool "${toolName}" was blocked by the ` +
    `"${profileName}" permission profile (${reason}). ` +
    `The call was not executed; continue without this tool. (probeId: ${probeId})`
  );
}

/**
 * PURE — no I/O, no process/time non-determinism (unlike
 * `permission-check-mcp-server.ts`'s `handleCheckPermission`, this tool
 * needs no `process.pid`). Exported and directly callable so this is
 * testable without spawning any process or MCP transport.
 */
export function handleDenyProbe(args: DenyProbeArgs): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  const policy = resolvePermissionProfile(PERMISSION_PROFILE_NAME);
  const evaluation = evaluatePermission(policy, DENY_TOOL_NAME);
  if (evaluation.decision !== 'deny') {
    // Fail loudly rather than silently returning a misleading "deny" probe
    // result if the policy this spike depends on ever changes underneath it.
    throw new Error(
      `deny_probe: expected "${DENY_TOOL_NAME}" to be denied under the ` +
        `"${PERMISSION_PROFILE_NAME}" profile, got "${evaluation.decision}"`,
    );
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: buildMirroredDenyText(
          DENY_TOOL_NAME,
          PERMISSION_PROFILE_NAME,
          evaluation.reason,
          args.probeId,
        ),
      },
    ],
  };
}

/** PURE — same determinism guarantee as `handleDenyProbe`. */
export function handleAllowProbe(args: AllowProbeArgs): {
  content: [{ type: 'text'; text: string }];
} {
  const policy = resolvePermissionProfile(PERMISSION_PROFILE_NAME);
  const evaluation = evaluatePermission(policy, ALLOW_TOOL_NAME);
  if (evaluation.decision !== 'allow') {
    throw new Error(
      `allow_probe: expected "${ALLOW_TOOL_NAME}" to be allowed under the ` +
        `"${PERMISSION_PROFILE_NAME}" profile, got "${evaluation.decision}"`,
    );
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          probeId: args.probeId,
          decision: 'allow',
          toolName: ALLOW_TOOL_NAME,
        }),
      },
    ],
  };
}

/** Builds the MCP server with both tools registered. Separated from the
 *  transport-connection side effect below so tests can construct it (or
 *  just call the handlers directly) without starting stdio. */
export function createPermissionDenyMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'deus_lia449b_permission_deny', version: '0.1.0' },
    { capabilities: {} },
  );

  server.tool(
    'deny_probe',
    `Always denied: evaluates the real "${PERMISSION_PROFILE_NAME}" ` +
      `permission profile against "${DENY_TOOL_NAME}" (a known ` +
      'mutation-capable tool) and returns a real MCP tool error whose text ' +
      "mirrors Deus's production permission-denial message. Echoes back " +
      'the given probeId inside the error text.',
    {
      probeId: z
        .string()
        .describe(
          'Opaque caller-chosen id, echoed back inside the error text.',
        ),
    },
    async (args) => handleDenyProbe(args),
  );

  server.tool(
    'allow_probe',
    `Always allowed: evaluates the real "${PERMISSION_PROFILE_NAME}" ` +
      `permission profile against "${ALLOW_TOOL_NAME}" (a known read-only ` +
      'tool) and returns a normal (non-error) MCP result. Echoes back the ' +
      'given probeId inside the JSON result body.',
    {
      probeId: z
        .string()
        .describe('Opaque caller-chosen id, echoed back verbatim.'),
    },
    async (args) => handleAllowProbe(args),
  );

  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const server = createPermissionDenyMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
