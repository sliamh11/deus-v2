/**
 * Oracle tests for LIA-407/B7 — the permissions middleware's deny path:
 * non-delegation to the underlying tool handler, and model-visible denial
 * feedback that does not leak the original call's arguments.
 *
 * @oracle Independently authored from the SHIP'd plan
 * (.claude/.plan-scope-b7.md, AC2 + AC3) and the Linear ticket LIA-407, BLIND
 * to the implementation. `buildPermissionsMiddleware` in `middleware-stack.ts`
 * is TODAY an allow-all placeholder (see that file's own doc comment: "always
 * allows every tool call through ... The real substance is B7/LIA-407's
 * declarative permission-rules engine"). This file targets the FUTURE real
 * middleware, wired with the read-only profile, against a synthetic
 * mutation-shaped tool. Must not be weakened by the implementer; strengthen
 * instead of loosen if a real gap is found during implementation.
 *
 * SPEC (from the plan, verbatim intent):
 *   - AC2: "In buildPermissionsMiddleware, evaluate request.toolCall.name.
 *     For allow, record the decision and call handler(request) exactly once
 *     with the original object. For deny, record the decision and return a
 *     synthetic ToolMessage with the original tool name/id, status: 'error',
 *     and stable content identifying permission_denied, the profile, and the
 *     reason; never call the handler."
 *   - AC2: "Do not include tool arguments in denial feedback, avoiding
 *     needless exposure of potentially sensitive values while still telling
 *     the model what was blocked and how to continue without that tool."
 *   - AC2: "Add a hermetic real-createAgent test using FakeToolCallingModel
 *     and a mutation-tool spy, asserting the spy is untouched and the
 *     resulting graph messages contain the synthetic denial ToolMessage.
 *     This follows the existing real-agent test pattern
 *     (middleware-stack.test.ts:96-173)."
 *   - AC3: "default deny for unknown/dynamic/MCP tools" — exercised here at
 *     the real middleware/agent level, not just the pure evaluator.
 *   - AC5: only reject/respond outcomes exist; a deny never rewrites the
 *     request or reaches the handler via a reconstructed object.
 *
 * This file is RED against the current tree for a behavioral reason (not an
 * import-resolution reason): `buildMiddlewareStack` and `createMiddleware`
 * already exist and compile fine, but today's permissions layer is the
 * allow-all placeholder — it calls `handler(request)` unconditionally and
 * never returns a denial `ToolMessage`. So the assertions below (spy never
 * called; a denial `ToolMessage` exists) FAIL against the current tree. It
 * must go GREEN once the implementer replaces the placeholder per AC2/AC3,
 * WITHOUT this file being edited to match whatever shape the implementation
 * happens to take.
 *
 * TEST-SEAM REQUIREMENT imposed on the implementer (derived directly from
 * the plan's Scope section, which names the exact config key/value):
 *   "Wire named-profile selection through the existing RunContext.backendConfig
 *   seam into BuildMiddlewareStackDeps ... permissionProfile: "read-only"
 *   will select the read-only preset."
 *   -> `BuildMiddlewareStackDeps` (src/agent-runtimes/middleware-stack.ts)
 *      gains an optional `permissionProfile?: string` field; when present,
 *      `buildMiddlewareStack` resolves it against the permission-rules
 *      profile registry and wires the resulting policy into the real
 *      permissions middleware. Omitted => today's default/allow-all-shaped
 *      profile (Scope: "Omitted configuration will retain today's behavior
 *      via the normal/default profile").
 * This test deliberately reuses the EXISTING, already-shipped
 * `buildMiddlewareStack(config, deps)` entry point (config disables the
 * wardens/memory/telemetry layers — already tested, already GREEN — so only
 * the permissions layer under test is wired into the agent) rather than
 * guessing `buildPermissionsMiddleware`'s own new internal signature, to
 * minimize assumptions about implementation shape per oracle-rules.md
 * `contract-level`.
 * A genuinely incorrect seam may only be changed by the oracle author or a
 * reviewer, with the reason recorded — never silently by the implementer.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgent, tool, FakeToolCallingModel } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

import { buildMiddlewareStack } from './middleware-stack.js';

// ---------------------------------------------------------------------------
// A synthetic mutation-shaped tool: real langchain StructuredTool wiring
// (so it goes through the genuine wrapToolCall onion), but its execute
// function is a pure vi.fn() spy — never a real filesystem/shell effect.
// Named 'write_file' to match a real broker mutation-tool name from the
// plan's Research section, so the read-only profile's explicit deny rule
// fires (not merely the unknown-tool default) for the primary case; a
// second describe block below separately proves the unknown-tool default.
// ---------------------------------------------------------------------------

const SENTINEL_SECRET = 'SENTINEL_SECRET_do_not_leak_into_denial_feedback';
const SENTINEL_PATH = '/etc/should-not-appear-in-denial-content';

function makeSpiedTool(name: string, description: string) {
  const handlerSpy = vi.fn(async (_args: { path: string; content: string }) => {
    return `WROTE:${_args.path}`;
  });
  const spiedTool = tool(handlerSpy, {
    name,
    description,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  });
  return { spiedTool, handlerSpy };
}

function scriptedModelCalling(toolName: string): FakeToolCallingModel {
  return new FakeToolCallingModel({
    toolCalls: [
      [
        {
          name: toolName,
          args: { path: SENTINEL_PATH, content: SENTINEL_SECRET },
          id: 'call_1',
        },
      ],
      [], // second cycle: plain final answer, ends the ReAct loop
    ],
  });
}

function findToolMessages(messages: unknown[]): ToolMessage[] {
  return messages.filter((m): m is ToolMessage =>
    ToolMessage.isInstance(m as never),
  );
}

// ===========================================================================
// 1) A known mutation tool ('write_file') under the read-only profile:
//    the handler is NEVER invoked, and the model gets a denial ToolMessage
//    that identifies the denial without leaking the call's arguments.
// ===========================================================================

describe('@oracle permissions middleware — deny path never delegates to the handler (AC2, AC5)', () => {
  it('@oracle a denied write_file call: handler spy has ZERO calls', async () => {
    // @oracle: AC2 — "For deny ... never call the handler."
    const { spiedTool, handlerSpy } = makeSpiedTool(
      'write_file',
      'oracle test double for a real broker mutation tool',
    );
    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'read-only' },
    );

    const agent = createAgent({
      model: scriptedModelCalling('write_file'),
      tools: [spiedTool],
      middleware,
    });
    await agent.invoke({
      messages: [{ role: 'user', content: 'write something to disk' }],
    });

    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('@oracle a denied write_file call: the graph messages contain a model-visible denial ToolMessage', async () => {
    // @oracle: AC2 — "return a synthetic ToolMessage with the original tool
    // name/id, status: 'error', and stable content identifying
    // permission_denied, the profile, and the reason"
    const { spiedTool } = makeSpiedTool(
      'write_file',
      'oracle test double for a real broker mutation tool',
    );
    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'read-only' },
    );

    const agent = createAgent({
      model: scriptedModelCalling('write_file'),
      tools: [spiedTool],
      middleware,
    });
    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'write something to disk' }],
    });

    const toolMessages = findToolMessages(
      (result as { messages: unknown[] }).messages,
    );
    const denial = toolMessages.find((m) => m.tool_call_id === 'call_1');
    expect(denial).toBeDefined();
    expect(denial?.status).toBe('error');

    const content =
      typeof denial?.content === 'string'
        ? denial.content
        : JSON.stringify(denial?.content);
    // Identifies the denial and the profile (AC2's literal "permission_denied
    // ... the profile ... the reason").
    expect(content).toContain('permission_denied');
    expect(content).toContain('read-only');
    // Identifies which tool was blocked (AC2's "original tool name").
    expect(content).toContain('write_file');
  });

  it('@oracle a denied write_file call: denial content does NOT expose the original call arguments', async () => {
    // @oracle: AC2 — "Do not include tool arguments in denial feedback,
    // avoiding needless exposure of potentially sensitive values"
    const { spiedTool } = makeSpiedTool(
      'write_file',
      'oracle test double for a real broker mutation tool',
    );
    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'read-only' },
    );

    const agent = createAgent({
      model: scriptedModelCalling('write_file'),
      tools: [spiedTool],
      middleware,
    });
    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'write something to disk' }],
    });

    const toolMessages = findToolMessages(
      (result as { messages: unknown[] }).messages,
    );
    const denial = toolMessages.find((m) => m.tool_call_id === 'call_1');
    const content =
      typeof denial?.content === 'string'
        ? denial.content
        : JSON.stringify(denial?.content);

    expect(content).not.toContain(SENTINEL_SECRET);
    expect(content).not.toContain(SENTINEL_PATH);
  });
});

// ===========================================================================
// 2) An unknown/unrecognized tool name under the read-only profile: proves
//    AC3's fail-closed default at the real middleware/agent level (not just
//    the pure evaluator covered by permission-rules.oracle.test.ts).
// ===========================================================================

describe('@oracle permissions middleware — unknown tool is fail-closed at the real agent boundary (AC3)', () => {
  it('@oracle a call to an unrecognized tool name: handler spy has ZERO calls and a denial ToolMessage is produced', async () => {
    // @oracle: AC3 — "default deny for unknown/dynamic/MCP tools", exercised
    // through the real wrapToolCall wiring, not the pure evaluator directly.
    const UNKNOWN_TOOL_NAME = 'totally_unclassified_tool_never_in_broker';
    const { spiedTool, handlerSpy } = makeSpiedTool(
      UNKNOWN_TOOL_NAME,
      'oracle test double for a tool with no explicit rule',
    );
    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'read-only' },
    );

    const agent = createAgent({
      model: scriptedModelCalling(UNKNOWN_TOOL_NAME),
      tools: [spiedTool],
      middleware,
    });
    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'call the unclassified tool' }],
    });

    expect(handlerSpy).not.toHaveBeenCalled();

    const toolMessages = findToolMessages(
      (result as { messages: unknown[] }).messages,
    );
    const denial = toolMessages.find((m) => m.tool_call_id === 'call_1');
    expect(denial).toBeDefined();
    expect(denial?.status).toBe('error');
  });
});

// ===========================================================================
// 3) Decision log parity: the permissions layer's inspectable log (AC1's
//    "extend ToolCallDecisionRecord from allow-only to allow | deny") agrees
//    with the ToolMessage-level observation above — the log is not merely
//    cosmetic while the real gate silently still allows.
// ===========================================================================

describe('@oracle permissions middleware — decision log records the deny (AC1, AC2)', () => {
  it('@oracle logs.permissions contains a deny record for the blocked write_file call', async () => {
    // @oracle: AC1 — "Extend ToolCallDecisionRecord from allow-only to
    // allow | deny and include evaluation source/reason"
    const { spiedTool } = makeSpiedTool(
      'write_file',
      'oracle test double for a real broker mutation tool',
    );
    const { middleware, logs } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'read-only' },
    );

    const agent = createAgent({
      model: scriptedModelCalling('write_file'),
      tools: [spiedTool],
      middleware,
    });
    await agent.invoke({
      messages: [{ role: 'user', content: 'write something to disk' }],
    });

    const denyRecords = (logs.permissions ?? []).filter(
      (r) => r.toolName === 'write_file',
    );
    expect(denyRecords.length).toBeGreaterThan(0);
    for (const record of denyRecords) {
      expect(record.decision).toBe('deny');
    }
  });
});
