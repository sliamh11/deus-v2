/**
 * Oracle tests for the "interactive permission prompts for `deus chat`"
 * follow-up ticket (LIA-466;
 * ADR amendment: `docs/decisions/deus-v2-permission-rules.md`, "Amendment
 * (2026-07-21)" section) -- explicit authorization or fail-closed at the
 * `wrapToolCall` 'ask' branch.
 *
 * @oracle Independently authored from the plan + ADR amendment SPEC ALONE,
 * BLIND to the implementation. As of authoring time, `buildMiddlewareStack`'s
 * permissions layer (`middleware-stack.ts`) only ever produces `'allow'`/
 * `'deny'` outcomes -- verified by reading the file directly before writing
 * this test: `buildPermissionsMiddleware`'s `wrapToolCall` calls
 * `evaluatePermission` and branches ONLY on `evaluation.decision === 'allow'`
 * (delegate) vs. else (deny), with no async wait, no registry, no
 * `permissionInteractive`/interactive-deps parameter anywhere in
 * `BuildMiddlewareStackDeps`, and no `'interactive'` entry in
 * `PERMISSION_PROFILES`. Nothing in this file was informed by any
 * implementation diff. Must not be weakened by the implementer; strengthen
 * instead of loosen if a real gap is found.
 *
 * SPEC (from the plan + ADR amendment, verbatim intent):
 *   - Plan Implementation step 4: "`wrapToolCall`'s `'ask'` branch: generate
 *     a `requestId`, `registry.register(requestId)`, emit a
 *     `permission_request` `RuntimeEvent` via `eventSink` (bounded
 *     `toolInputPreview`, ~200 chars), await the decision, `deny` ->
 *     synthetic `permission_denied` `ToolMessage` (same shape as today's
 *     deny path); `allow_once`/`allow_always` -> `handler(request)`. `'ask'`
 *     with no `interactive` deps supplied -> fail closed to deny (distinct
 *     reason string), never silently allow."
 *   - Plan Implementation step 4: "new exported `InteractivePermissionDeps
 *     { registry, eventSink, sessionId }`; `buildPermissionsMiddleware`
 *     gains an optional 3rd param ... `BuildMiddlewareStackDeps` gains
 *     `permissionInteractive?`."
 *   - Plan Implementation step 2: "New `src/agent-runtimes/
 *     permission-registry.ts` -- `PendingPermissionRegistry` promoted
 *     verbatim from the LIA-465 spike (`Map<requestId, {resolve, timeout}>`,
 *     O(1) register/resolve, `DENY_TIMEOUT_MS = 120_000` timeout-to-deny)."
 *   - Plan Verification step 6 (this file's own mandate): "the handler
 *     cannot run before an explicit allowing response, exactly one
 *     correlated `permission_request` is emitted, `deny` produces the normal
 *     denial with zero handler calls, and omitting `interactive` deps fails
 *     closed without advancing the timeout."
 *   - ADR (unchanged by the amendment), AC2: denial is a synthetic
 *     `ToolMessage`, `status: 'error'`, original tool name/id, content
 *     identifying `permission_denied` + profile + reason, handler never
 *     called; on allow, `handler(request)` is called exactly once.
 *
 * This file is RED against the current tree for TWO independent reasons,
 * either one sufficient on its own:
 *   1. Import-resolution: `PendingPermissionRegistry` is imported from
 *      `./permission-registry.ts`, the promoted module step 2 above
 *      describes -- it does not exist yet on the pre-implementation tree
 *      (only the LIA-465 spike's own copy at
 *      `scripts/spikes/lia465_protocol_boundary_permission_spike.ts` exists,
 *      deliberately NOT this file's import target, since the plan's whole
 *      point is promoting that class out of the spike).
 *   2. Behavioral: even if that import somehow resolved, every test below
 *      calls `buildMiddlewareStack(..., { permissionProfile: 'interactive',
 *      ... })`, and `buildMiddlewareStack` validates `permissionProfile` up
 *      front via `resolvePermissionProfile`, which THROWS synchronously on
 *      an unrecognized name today (`'interactive'` is not yet a key of
 *      `PERMISSION_PROFILES`) -- before any agent is even constructed.
 * It must go GREEN once the implementer wires the real `'ask'` branch per
 * the plan, WITHOUT this file being edited to match whatever shape the
 * implementation happens to take.
 *
 * TEST-SEAM REQUIREMENTS imposed on the implementer (derived directly from
 * the plan's Implementation section):
 *   - `src/agent-runtimes/permission-registry.ts` exports a
 *     `PendingPermissionRegistry` class with `register(requestId): Promise
 *     <PermissionDecision>` and `resolve(requestId, decision): boolean`
 *     (same shape as the LIA-465 spike's own class, promoted verbatim).
 *   - `BuildMiddlewareStackDeps` gains an optional `permissionInteractive`
 *     field accepting a plain `{ registry, eventSink, sessionId }` object
 *     (this file constructs it as a plain object literal, not a named
 *     imported type, to minimize assumptions about the implementer's exact
 *     type name/shape beyond the plan's literal field list -- mirroring
 *     `middleware-stack.oracle.test.ts`'s existing `contract-level`
 *     discipline).
 *   - Under `permissionProfile: 'interactive'`, a call to `web_search`/
 *     `web_fetch` triggers the 'ask' branch described above.
 * A genuinely incorrect seam may only be changed by the oracle author or a
 * reviewer, with the reason recorded -- never silently by the implementer.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgent, tool, FakeToolCallingModel } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';

import { buildMiddlewareStack } from './middleware-stack.js';
// The promoted-module seam the plan's Implementation step 2 describes. Does
// NOT exist on the pre-implementation tree -- see file header, red reason 1.
import { PendingPermissionRegistry } from './permission-registry.js';
import type { RuntimeEvent } from './types.js';

const SENTINEL_QUERY = 'SENTINEL_QUERY_do_not_mutate_before_delegating';

function makeSpiedWebSearchTool() {
  const handlerSpy = vi.fn(async (_args: { query: string }) => {
    return `RESULTS_FOR:${_args.query}`;
  });
  const spiedTool = tool(handlerSpy, {
    name: 'web_search',
    description: 'oracle test double for the real broker web_search tool',
    schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  });
  return { spiedTool, handlerSpy };
}

function scriptedWebSearchModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({
    toolCalls: [
      [{ name: 'web_search', args: { query: SENTINEL_QUERY }, id: 'call_1' }],
      [], // second cycle: plain final answer, ends the ReAct loop
    ],
  });
}

function findToolMessages(messages: unknown[]): ToolMessage[] {
  return messages.filter((m): m is ToolMessage =>
    ToolMessage.isInstance(m as never),
  );
}

function denialToolMessage(messages: unknown[]): ToolMessage | undefined {
  return findToolMessages(messages).find((m) => m.tool_call_id === 'call_1');
}

// ===========================================================================
// (a) Interactive deps SUPPLIED -- explicit authorization is required before
//     the handler ever runs; both the deny and allow_once outcomes are
//     proven end to end through the real agent/middleware wiring.
// ===========================================================================

describe("@oracle interactive 'ask' branch -- deny path never delegates, produces one correlated permission_request (plan step 4, ADR AC2)", () => {
  it('@oracle deny: exactly one permission_request event fires BEFORE the handler runs, handler ends with ZERO calls, denial ToolMessage matches AC2 shape', async () => {
    const { spiedTool, handlerSpy } = makeSpiedWebSearchTool();
    const events: RuntimeEvent[] = [];
    const registry = new PendingPermissionRegistry();
    let handlerCallsObservedAtEventTime: number | undefined;

    const eventSink = (event: RuntimeEvent) => {
      events.push(event);
      if (event.type !== 'permission_request') return;
      // @oracle: plan step 4 -- the handler must not have run before the
      // decision is made. Captured at the moment the event fires, which is
      // strictly before this callback resolves the registry below.
      handlerCallsObservedAtEventTime = handlerSpy.mock.calls.length;
      registry.resolve(event.requestId, 'deny');
    };

    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      {
        permissionProfile: 'interactive',
        permissionInteractive: {
          registry,
          eventSink,
          sessionId: 'oracle-session-deny',
        },
      },
    );

    const agent = createAgent({
      model: scriptedWebSearchModel(),
      tools: [spiedTool],
      middleware,
    });
    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'search the web for something' }],
    });

    // @oracle: "exactly one correlated permission_request event is emitted"
    const permissionRequestEvents = events.filter(
      (e) => e.type === 'permission_request',
    );
    expect(permissionRequestEvents).toHaveLength(1);
    expect(permissionRequestEvents[0]).toMatchObject({
      toolName: 'web_search',
    });

    // @oracle: "before resolution the handler has zero calls"
    expect(handlerCallsObservedAtEventTime).toBe(0);
    // @oracle: AC2 -- deny "never calls the handler" (final state, after the
    // whole turn completed).
    expect(handlerSpy).not.toHaveBeenCalled();

    // @oracle: AC2 -- "the normal model-visible denial ToolMessage" (same
    // shape as the existing non-interactive deny path).
    const denial = denialToolMessage(
      (result as { messages: unknown[] }).messages,
    );
    expect(denial).toBeDefined();
    expect(denial?.status).toBe('error');
    const content =
      typeof denial?.content === 'string'
        ? denial.content
        : JSON.stringify(denial?.content);
    expect(content).toContain('permission_denied');
    expect(content).toContain('web_search');
  });
});

describe("@oracle interactive 'ask' branch -- allow_once delegates exactly once, only after the explicit decision (plan step 4)", () => {
  it('@oracle allow_once: handler is called exactly once, with the unmutated original tool-call arguments, and NOT before the decision resolves', async () => {
    const { spiedTool, handlerSpy } = makeSpiedWebSearchTool();
    const events: RuntimeEvent[] = [];
    const registry = new PendingPermissionRegistry();
    let handlerCallsObservedAtEventTime: number | undefined;

    const eventSink = (event: RuntimeEvent) => {
      events.push(event);
      if (event.type !== 'permission_request') return;
      // @oracle: the handler must not have run yet at the moment the
      // permission_request is emitted, even on the eventual-allow path.
      handlerCallsObservedAtEventTime = handlerSpy.mock.calls.length;
      registry.resolve(event.requestId, 'allow_once');
    };

    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      {
        permissionProfile: 'interactive',
        permissionInteractive: {
          registry,
          eventSink,
          sessionId: 'oracle-session-allow',
        },
      },
    );

    const agent = createAgent({
      model: scriptedWebSearchModel(),
      tools: [spiedTool],
      middleware,
    });
    await agent.invoke({
      messages: [{ role: 'user', content: 'search the web for something' }],
    });

    expect(handlerCallsObservedAtEventTime).toBe(0);
    // @oracle: plan step 4 -- "allow_once/allow_always -> handler(request)",
    // called exactly once.
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    // @oracle: the delegated call carries the ORIGINAL tool-call arguments,
    // unmutated by the permissions layer -- the observable proxy for "the
    // ORIGINAL unmodified request object" (object-identity of the internal
    // wrapToolCall `request` is adapter-construction plumbing, not a
    // security-relevant behavior an independent oracle should pin per the
    // ADR's own precedent: "The allow-path frozen/nested request-identity
    // test remains implementation-authored, since it verifies adapter
    // construction rather than a security decision" -- see this file's "Not
    // covered" note).
    // Reviewer fix (not implementer, per this file's own "Not covered" note
    // and the ADR's precedent that a genuinely incorrect oracle may only be
    // changed by its author or a reviewer, reason recorded): the original
    // matcher assumed the spied tool function is invoked with exactly one
    // argument. Verified directly against middleware-stack.ts -- wrapToolCall
    // calls `handler(request)` with exactly one argument at every call site,
    // unchanged from the pre-existing allow path. The two-argument
    // `(args, config)` invocation observed here is LangChain's own tool-node
    // calling convention for the underlying tool function, downstream of and
    // uncontrolled by this middleware -- not a security-relevant behavior.
    // Assert on the first (args) argument only, preserving the oracle's
    // actual intent (unmutated original arguments delegated).
    expect(handlerSpy.mock.calls[0]?.[0]).toEqual({ query: SENTINEL_QUERY });
  });
});

// ===========================================================================
// (b) Interactive deps OMITTED -- the same 'ask' call must fail closed
//     IMMEDIATELY (never waiting for/advancing the 120s registry timeout),
//     never call the handler, and return the synthetic denial.
// ===========================================================================

describe("@oracle interactive 'ask' branch -- omitted interactive deps fail closed WITHOUT waiting for the 120s timeout (plan step 4)", () => {
  it('@oracle no permissionInteractive deps supplied: settles to deny in well under a second (not 120s), handler never called, synthetic denial returned', async () => {
    const { spiedTool, handlerSpy } = makeSpiedWebSearchTool();

    const { middleware } = buildMiddlewareStack(
      { wardens: false, memory: false, telemetry: false },
      { permissionProfile: 'interactive' }, // permissionInteractive: OMITTED
    );

    const agent = createAgent({
      model: scriptedWebSearchModel(),
      tools: [spiedTool],
      middleware,
    });

    const startedAt = Date.now();
    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'search the web for something' }],
    });
    const elapsedMs = Date.now() - startedAt;

    // @oracle: plan step 4 -- "'ask' with no interactive deps supplied ->
    // fail closed to deny ... never silently allow." The DENY_TIMEOUT_MS
    // registry fallback is 120_000ms; a correct fail-closed implementation
    // never touches that timer on this path at all, so this must resolve in
    // a tiny fraction of that -- not merely "eventually" via the timeout. A
    // buggy implementation that (incorrectly) routed this through
    // registry.register()'s real 120s timer would fail this assertion (and
    // very likely this test's own runner timeout below) instead of
    // resolving near-instantly.
    expect(elapsedMs).toBeLessThan(5_000);

    expect(handlerSpy).not.toHaveBeenCalled();

    const denial = denialToolMessage(
      (result as { messages: unknown[] }).messages,
    );
    expect(denial).toBeDefined();
    expect(denial?.status).toBe('error');
    const content =
      typeof denial?.content === 'string'
        ? denial.content
        : JSON.stringify(denial?.content);
    expect(content).toContain('permission_denied');
  }, 10_000);
});
