/**
 * Transport-neutral pre-execution gate for MCP tool handlers (LIA-454 EP-002
 * step 7). Shared by the nested-dispatch child server (`nested-dispatch-
 * mcp-server.ts`) and the future parent-turn MCP server (step 8) — one
 * policy/warden mediator, reviewable once, instead of copied into two
 * executable servers.
 *
 * Reuses, never duplicates, the SAME real enforcement primitives the
 * existing LangChain `wardens`/`permissions` middleware
 * (`middleware-stack.ts`) already calls: `evaluatePermission`/
 * `resolvePermissionProfile` (`permission-rules.ts`) and
 * `runWardenBehavior`/`selectWardenBehaviors`/`fallbackRevisedMessage`
 * (`middleware-stack.ts`, exported for exactly this reuse). This closes the
 * parity gap `nested-dispatch-mcp-server.ts`'s original inline gate left
 * open: it only DETECTED a future warden-gated tool and denied it
 * unconditionally, rather than actually invoking the real Python gate
 * runner the way the LangChain path does.
 */

import path from 'node:path';

import {
  evaluatePermission,
  resolvePermissionProfile,
} from '../permission-rules.js';
import {
  fallbackRevisedMessage,
  resolveWardenRepoRoot,
  runWardenBehavior,
  selectWardenBehaviors,
  type MiddlewareStackConfig,
} from '../middleware-stack.js';

export interface McpToolResult {
  [x: string]: unknown;
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export interface McpGateContext {
  permissionProfile: string | null | undefined;
  wardenCwd: string;
  /** LIA-410's explicit workspace-root channel, threaded to the wardens gate
   *  runner identically to the LangChain path — see `middleware-stack.ts`'s
   *  own `workspaceRoot` doc comment. */
  workspaceRoot?: string;
}

function permissionDenyResult(
  toolName: string,
  reasonText: string,
): McpToolResult {
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

/** Wardens deny with the RAW reason text verbatim — matching
 *  `buildWardensMiddleware`'s own `content: reason` exactly (a genuine
 *  Python deny already carries its own full explanation; a gate
 *  infrastructure failure gets `fallbackRevisedMessage`'s stable sanitized
 *  text) — never re-wrapped in the permission-specific "blocked (...)"
 *  phrasing, which is a distinct denial shape for a distinct layer. */
function wardenDenyResult(reasonText: string): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: reasonText }],
  };
}

/**
 * Runs the permissions layer then the wardens layer (same order
 * `CANONICAL_MIDDLEWARE_ORDER` fixes for the LangChain path), honoring the
 * SAME `MiddlewareStackConfig` per-layer toggles `buildMiddlewareStack`
 * does, then invokes `realAction` exactly once, only if every enabled gate
 * allows. Never invokes `realAction` more than once, and never invokes it
 * before every gate has resolved.
 */
export async function gateAndExecuteMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  context: McpGateContext,
  config: MiddlewareStackConfig,
  realAction: (args: Record<string, unknown>) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  // B7 (middleware-stack.ts:859-865)'s own contract: an invalid profile name
  // fails visibly even when the permissions layer itself is disabled — never
  // silently ignored while the caller believes a restriction is in force.
  const profileName = context.permissionProfile ?? 'default';
  let policy: ReturnType<typeof resolvePermissionProfile>;
  try {
    policy = resolvePermissionProfile(profileName);
  } catch (err) {
    return permissionDenyResult(
      toolName,
      `permission profile resolution failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (config.permissions !== false) {
    const evaluation = evaluatePermission(policy, toolName);
    if (evaluation.decision !== 'allow') {
      return permissionDenyResult(
        toolName,
        `blocked by the "${profileName}" permission profile (${evaluation.reason})`,
      );
    }
  }

  if (config.wardens !== false) {
    const behaviors = selectWardenBehaviors(toolName, args);
    if (behaviors.length > 0) {
      // Self-normalize, matching `buildWardensMiddleware`'s own defense: a
      // relative cwd would violate the Python hook's absolute-path
      // contract. This gate is the shared entry point for a FUTURE caller
      // too (the step-8 parent-turn MCP server) — normalizing here rather
      // than trusting every future caller to pre-resolve is the same
      // "not just at the call site" posture `middleware-stack.ts` already
      // documents for its own public entry point.
      const resolvedWardenCwd = path.resolve(context.wardenCwd);
      const resolvedWorkspaceRoot =
        context.workspaceRoot !== undefined
          ? path.resolve(context.workspaceRoot)
          : undefined;
      const repoRoot = resolveWardenRepoRoot(resolvedWardenCwd);
      const event = {
        cwd: resolvedWardenCwd,
        tool_name: toolName,
        tool_input: args,
      };
      for (const behavior of behaviors) {
        const outcome = await runWardenBehavior(
          behavior,
          event,
          repoRoot,
          resolvedWorkspaceRoot,
        );
        if (outcome.kind === 'allow') continue;
        const reason =
          outcome.kind === 'deny'
            ? outcome.reason
            : fallbackRevisedMessage(behavior);
        return wardenDenyResult(reason);
      }
    }
  }

  return realAction(args);
}
