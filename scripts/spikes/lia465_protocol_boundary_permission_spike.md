# Spike: session/tool/permission protocol boundary (LIA-465)

This spike validates that a UI-agnostic session/tool/permission protocol
boundary is workable for deus-v2: a client (eventually a web dashboard, TUI,
or CLI) can observe a live `permission_request` over SSE and answer it, with
the answer resolving an in-process await, end to end — with **zero changes to
any production request-handling file**. Full context, the preceding research
(6-scout swarm + a 2-round Fable/GPT-5.6-Sol debate on forking OpenAI's
`codex-rs/tui` vs. building a bespoke protocol) and the relationship to
`docs/decisions/deus-v2-permission-rules.md` (B7/LIA-407) are recorded in the
plan (see the Linear issue). Summary here: the debate converged on extending
Deus's own `RuntimeEvent`/`RuntimeActivityBroadcaster` seam with a symmetric
`RuntimeCommand` inbound type — stealing Codex's SQ/EQ protocol *shape*
(correlated request IDs, typed terminal outcomes) as design inspiration only,
never its wire format, TUI, or hooks. `wrapToolCall` remains the sole
permission authority; this spike does not touch it.

## Mechanism

1. `PermissionDecision = 'allow_once' | 'allow_always' | 'deny'` and a new
   `permission_request` `RuntimeEvent` variant, plus a new `RuntimeCommand`
   union (`permission_response`, and a type-only, unimplemented `interrupt`)
   — all additive to `src/agent-runtimes/types.ts`.
2. `PendingPermissionRegistry` (Registry pattern, `Map<requestId, {resolve,
   timeout}>`, O(1) register/resolve) — 120s timeout-to-deny, mirroring
   `docs/decisions/tui-permission-bridge.md` decision #4.
3. A synthetic, spike-only `AgentRuntime` that emits `permission_request` and
   awaits the registry before resolving — proving the round trip without
   touching any real runtime or `wrapToolCall`.
4. The real, unmodified `withRuntimeActivityBroadcast` decorator
   (`src/agent-runtimes/activity-broadcaster.ts`) wraps the synthetic
   runtime, so the event genuinely flows through production broadcast code
   — not a reimplementation of it.
5. A standalone HTTP+SSE server, spike-scoped only (`startSpikeServer`) —
   `GET /activity` (SSE) and `POST /activity/:requestId/respond`. This is
   **not** registered with, or reachable through, `src/odysseus-server.ts`'s
   real dispatcher — plan-review round 1 correctly flagged that file as
   production-wired (booted by every deployment via `src/index.ts:528`), so
   this revision keeps the new transport entirely out of it.

## Relationship to `docs/decisions/deus-v2-permission-rules.md`

That ADR's non-goals list "HITL approve/edit/interrupt flows, interactive
permission prompts" for B7/LIA-407, deferred because LangChain's own
installed HITL `edit` decision is documented as unreliable upstream
([`langchain-ai/langchain#33787`](https://github.com/langchain-ai/langchain/issues/33787)).
This spike does not depend on that mechanism: `PermissionDecision` has no
`edit` outcome, and nothing here imports or instantiates LangChain's
`interrupt()`/HITL middleware. The ADR itself states "deterministic
allow/deny policy enforcement has no dependency on" the upstream bug — this
spike's mechanism is exactly that, just resolved asynchronously via a
Deus-owned registry instead of synchronously.

The ADR's "Precondition for the first mutating-tool ticket" — (a) flip
`deus-native`'s default to a restrictive profile, or (b) add a
construction-time guard refusing non-`SAFE_TOOL_NAMES` tools under an
allow-all profile — applies to whichever future ticket wires this mechanism
into the real `wrapToolCall` for a real mutating tool, not to this spike,
which wires no mutating tool and touches no production tool surface.

## Live run evidence

A genuine race was found and fixed during this spike, not merely narrated:
the initial implementation started the synthetic turn immediately after
kicking off the SSE fetch, without waiting for the subscription to actually
register. `RuntimeActivityBroadcaster` has no replay buffer (fire-and-forward
only, per its own documented contract), so the `permission_request` event was
silently lost when the turn ran first — both round-trip tests timed out
(`vitest run`, 2 failures, 5000ms timeout each) before the fix. The fix waits
for `broadcaster.subscriberCount() > 0` (polled, 5s deadline) before starting
the turn. After the fix, all 10 tests pass:

```
Test Files  1 passed (1)
     Tests  10 passed (10)
```

**Standalone live run, allow path** (`npx tsx scripts/spikes/lia465_protocol_boundary_permission_spike.ts`):

```json
{
  "requestReceivedOverSse": true,
  "observedRequestId": "c101e34e-a3e3-47c8-a95e-0d12197ad734",
  "finalDecision": "allow_once",
  "runResult": {
    "status": "success",
    "result": "lia465_spike_tool executed (decision=allow_once)"
  }
}
```

**Standalone live run, deny path** (`runLiveRoundTrip('deny')`):

```json
{
  "requestReceivedOverSse": true,
  "observedRequestId": "fd5e1ee9-0a64-42c6-b51e-6755c79d6115",
  "finalDecision": "deny",
  "runResult": {
    "status": "error",
    "result": null,
    "error": "permission_denied: lia465_spike_tool (decision=deny)"
  }
}
```

Both paths show the full round trip working for real: request emitted →
received over a real SSE connection → response posted to a real HTTP
endpoint → the registry's awaited promise resolved with that exact decision
→ the runtime's `RunResult` reflects it correctly.

## Isolation verification

```
$ git diff --stat origin/main -- .
 .../lia465_protocol_boundary_permission_spike.test.ts | 135 ++++++++
 .../lia465_protocol_boundary_permission_spike.ts       | 346 +++++++++++++++++++++
 src/agent-runtimes/activity-broadcaster.ts             |  18 +-
 src/agent-runtimes/types.ts                            |  34 +-
 src/cli/deus-native-chat.ts                             |   5 +
 5 files changed, 536 insertions(+), 2 deletions(-)
```

`src/odysseus-server.ts` and `src/agent-runtimes/middleware-stack.ts` are
absent from the diff — genuinely untouched, as required. `types.ts` and
`activity-broadcaster.ts` carry only additive type/case changes. The one line
in `deus-native-chat.ts` is a mechanical exhaustiveness-guard fix (its
`switch (event.type)` over `RuntimeEvent` ends in a `const unhandled: never =
event` guard that would otherwise fail `tsc --noEmit` on the new variant) —
`npx tsc --noEmit` passes cleanly (exit 0) with this fix in place.

## Non-goals confirmed still out of scope

- No change to `wrapToolCall` or any real permission enforcement path.
- No `interrupt` handling — the `RuntimeCommand` variant exists for protocol
  symmetry only, unimplemented.
- No ACP adapter, no Codex TUI fork or compatibility shim.
- No web/TUI client UI.
- Multi-client fan-out/conflict semantics not addressed (single responder
  assumed — the standalone server has exactly one registry).

## Code-review addendum

`code-reviewer` (SHIP, one warning) flagged that the respond endpoint cast
the posted body to `RuntimeCommand` without validating `decision` against
the `PermissionDecision` union — an unvalidated string would have silently
resolved the pending promise as "success" for any typo or malformed client.
Fixed: `decision` is now checked against `PERMISSION_DECISIONS` and rejected
with 400 before touching the registry, with a regression test confirming a
malformed POST does not resolve the pending request (it still times out to
`deny` on its own schedule instead).

## Follow-up (separate ticket, not this spike)

Wiring a real `permission_response`-aware pause path into the production
`wrapToolCall`. Its acceptance criteria MUST include satisfying
`deus-v2-permission-rules.md`'s precondition for the first mutating-tool
ticket — (a) restrictive default profile, or (b) construction-time guard —
informed by the subscription-race lesson above (a production integration
needs an equivalent guarantee that a listener is attached before publishing,
or a real replay/queueing story, not just "SSE exists").
