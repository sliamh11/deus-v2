# Deus v2: Concurrent SubAgent Dispatch Primitive + Researcher (LIA-421, scoped)

**Status:** Accepted
**Date:** 2026-07-17
**Scope:** `src/agent-runtimes/subagent-dispatch.ts`, `.claude/agents/researcher.md`
**Related:**

- `deus-v2-subagent-dispatch.md` — B8/LIA-408's `createNestedDispatcher()` and
  E1/LIA-420's generic `.claude/agents/*.md` loader
  (`agent-spec-loader.ts`). This ADR builds directly on top of both,
  unmodified. Its own "Non-Goals" section explicitly lists "No recursive
  child-of-child dispatch, dependency graph, parallel fan-out... Children
  never receive `dispatch_nested_agent`" — this ADR fills exactly that gap,
  one layer above B8, without touching it.
- `docs/agent-agnostic-debt.md` (AAG-012) — tracks that the host-side
  `/deep-research` skill is invisible on the Codex backend and unreachable
  from chat channels because it depends on Claude-Code-specific interfaces
  (the Agent tool for subagent fan-out, host-only NotebookLM MCP,
  `AskUserQuestion`). One of AAG-012's own suggested fixes is "a container
  `agent.ts` that proxies the pipeline via IPC" — a `deus-native`
  chat-reachable SubAgent primitive is a plausible building block toward
  that, but is not that fix. **This ADR does not close AAG-012** — see
  "Not Included In This Change" below.

## Context

LIA-421 ("Restore deep-research fan-out parity") originally scoped a full
concurrent multi-agent research capability: automatic chat-message intent
detection, wiring into `DeusNativeRuntime.runTurn()`, and synthesis
middleware that injects fanned-out research results into a parent turn. That
larger scope was deliberately narrowed for this change (explicit user
decision) to just the reusable dispatch primitive plus one specialized
role, because:

- The only thing currently depending on deep-research fan-out parity is a
  future `deus-native` backend cutover that has not happened —
  `deus-native` is not yet the live default backend.
- Auto-triggering concurrent subagent dispatch (real latency + token cost)
  on every chat message that pattern-matches "research", with no concrete,
  deliberate consumer ready to use it, was judged too invasive to wire in
  blind.

B8 (`nested-dispatch.ts`) already provides a single, schema-validated,
one-shot nested dispatch (`NestedDispatcher.dispatch<T>(request)`), by
design with no fan-out (see its own ADR's Non-Goals). E1
(`agent-spec-loader.ts`) already generically loads any `.claude/agents/*.md`
role spec and adapts it into a B8-shaped request via
`buildAgentSpecDispatchRequest()`, reusing a generic `{content: string}`
output contract (`AGENT_SPEC_OUTPUT_CONTRACT`). Neither primitive needed to
change for this ticket — this ADR is purely additive: one new orchestration
function on top of B8's existing seam, plus one new checked-in role spec.

## Decision

### 1. `dispatchSubAgents()` — a flat, deterministic concurrent batch over B8

```ts
export interface SubAgentTask<T> {
  role: string; // batch-local identity; multiple tasks may share one B8 agentId
  request: NestedDispatchRequest<T>; // from nested-dispatch.ts, unchanged
}
export interface SubAgentOutcome<T> {
  index: number; // input order, preserved regardless of completion order
  role: string;
  agentId: string;
  requestedModel: string;
  result: NestedDispatchResult<T>; // success / contract_failure / error
}
export async function dispatchSubAgents<T>(
  dispatcher: NestedDispatcher,
  tasks: readonly SubAgentTask<T>[],
): Promise<SubAgentOutcome<T>[]>;
```

`dispatchSubAgents()` runs `Promise.all(tasks.map(...))` over B8's own
`dispatcher.dispatch()`, unmodified. Each task's `role`/`agentId`/
`requestedModel` identity is destructured from the input **before** the
`await dispatcher.dispatch(request)` call, and that same `await` is wrapped
in a `try/catch` that synthesizes a normal `NestedDispatchResult`'s
`'error'` variant (reusing the exact discriminated-union shape B8 already
defines — no second error type is invented) on any rejection. Because
identity is captured ahead of the suspension point, it survives even a
rejection that carries no identity of its own. `Promise.all` over
`tasks.map` guarantees the returned array is in input order regardless of
which task actually finishes first; `index` is carried anyway for callers
that later merge/reorder results.

### 2. Why not LangGraph's `Send()`

`@langchain/langgraph`'s `Send()` API is present as a transitive dependency
and unused anywhere in `src/`. It was rejected for this boundary because its
failure model is per-superstep and all-or-nothing: one branch throwing
rolls back the whole superstep, rather than producing an isolated result
for the branch that failed. This ticket's requirement — one task's failure
must never affect its siblings' results — is incompatible with that
model without extra bookkeeping `Send()` doesn't provide.

### 3. Why not implicit `ToolNode`/deepagents-style concurrency

LangChain's own `ToolNode` (and the `deepagents` SDK's `task` tool, built on
it) achieves concurrency by relying on `Promise.all` over whatever batch of
tool calls the calling LLM emits in a single turn. That pattern is a good
fit when the number and shape of concurrent calls is the *model's* own
judgment. It is the wrong fit here: `dispatchSubAgents()`'s task set is
chosen by **application code** — a fixed, deterministic list decided ahead
of time by the caller, not emitted by an LLM's tool-call batch. Reusing the
`ToolNode` pattern would mean routing a deterministic dispatch through an
LLM turn for no reason.

### 4. Why identity-before-await matters here specifically

B8's `dispatch()` (`nested-dispatch.ts`) wraps only model resolution and
child invocation in its own `try/catch` (roughly the `resolveModel()` +
`child.invoke()` span). Its `onUsage` reporting loop over completed child
`AIMessage`s, and the output contract's `outputContract.safeParseAsync()`
call, both run **after** that `try/catch` closes. A rejection from either
propagates out of `dispatch()` with no identity attached — B8's own
`metadata` construction is local to that closure and inaccessible to a
caller catching the rejection externally. `dispatchSubAgents()` closes this
gap at its own boundary: because `agentId`/`requestedModel`/`role` are
already local variables before the `await`, the wrapper can always
reconstruct a fully-identified `NestedDispatchResult` error, regardless of
where inside `dispatch()` the rejection actually originated. (The wrapper
cannot distinguish *which* internal phase rejected — a contract-validation
throw and an execution throw both surface as
`code: 'subagent_execution_failed'` — this is an accepted precision loss on
an already-failing path, not a correctness gap.)

### 5. Researcher — the first specialized SubAgent

`.claude/agents/researcher.md` is a new role spec, loaded with zero new
loader code (E1's `loadAgentSpecs()` already discovers any `.claude/agents/
*.md` file generically). Its methodology is adapted from
`.claude/agents/lit-scout.md`: sub-question decomposition, an L1-L5
evidence-quality taxonomy, explicit contradiction/uncertainty surfacing, and
a structured synthesis — generalized from "literature scout" framing to any
delegated research topic, and keeping lit-scout's "never cite or fabricate a
source or URL you did not actually retrieve" discipline intact. It declares
`model: sonnet` and no `linear_label` (Researcher is not part of the
warden/Linear gate pipeline). `buildAgentSpecDispatchRequest()` appends the
JSON response-envelope instruction automatically, so — matching
`lit-scout.md`'s own pattern — the role spec's body does not duplicate that
instruction itself.

## Alternatives Considered

- **Give `dispatchSubAgents()` its own richer output contract instead of
  reusing `AGENT_SPEC_OUTPUT_CONTRACT`.** Rejected for this scoped change:
  the generic `{content: string}` envelope E1 already validates is
  sufficient for a Researcher-shaped role, and inventing a second contract
  type would duplicate validation logic for no scoped requirement.
- **Add a concurrency/rate limit or dependency graph to `dispatchSubAgents()`
  now.** Rejected as premature: nothing calls this primitive with unbounded
  fan-out yet (see Non-Goals), so a budget/scheduler would be speculative
  hardening against a caller that does not exist.
- **Retry a failed task automatically inside `dispatchSubAgents()`.**
  Rejected: matches B8's own stance (no automatic schema-repair loop) — a
  failed task surfaces a traceable error; retry policy is the caller's
  decision, not this primitive's.

## Consequences

**Positive:**

- A reusable, independently tested concurrent dispatch primitive now exists
  on top of B8, without any change to B8 or E1.
- Researcher demonstrates the primitive end-to-end: two real role-spec-based
  dispatches, run concurrently, composing cleanly with E1's loader and
  output contract.
- Failure isolation and input-order preservation are proven by targeted
  tests, including a synthetic case exercising B8's own onUsage/
  safeParseAsync rejection gap that a naive `Promise.all` over
  `dispatcher.dispatch()` alone would not survive.

**Negative:**

- The wrapper cannot distinguish a contract-validation-phase rejection from
  an execution-phase rejection when synthesizing its `'error'` outcome —
  both are labeled `subagent_execution_failed`. Acceptable on an
  already-failing path; not corrected here.
- No concurrency limit, cancellation, or budget exists yet for a caller that
  dispatches a very large batch — deferred until a real caller needs it.

**Risks:**

- None beyond those already inherited from B8 (single Anthropic credential
  route, no per-turn dispatch cap) — this primitive adds no new credential
  path, tool surface, or model resolution logic of its own.

## Reversibility and rollback

**REVERSIBLE and additive-only.** This change adds exactly two new files
(`subagent-dispatch.ts`, `.claude/agents/researcher.md`) plus their test
file. No existing file is modified. Rollback is deleting these files; no
schema/data migration, no change to `RuntimeEvent`/`RunResult`/
`AgentRuntime` types, and no change to `deus-native-backend.ts`,
`context-registry.ts`, `router.ts`, or `message-orchestrator.ts` (all
untouched by this change).

## Not Included In This Change

This is a **deliberately scoped-down** slice of LIA-421. The following were
in the original, larger ticket framing and are explicitly deferred to a
future ticket:

- **No automatic chat-message intent detection** (no
  `detectDeepResearchIntent()` or equivalent).
- **No wiring into `DeusNativeRuntime.runTurn()`** — `deus-native-backend.ts`
  is untouched by this change.
- **No synthesis middleware** that automatically injects fanned-out
  SubAgent results into a parent turn.
- **No changes to `context-registry.ts`, `router.ts`, or
  `message-orchestrator.ts`.**

**AAG-012 (`docs/agent-agnostic-debt.md`) is NOT closed or partially closed
by this change.** AAG-012 documents that the host-side `/deep-research`
skill is invisible on the Codex backend and unreachable from chat channels
(WhatsApp, Telegram, Slack, Discord, Gmail, Teams, Outlook) because it
depends on Claude-Code-specific interfaces. This change adds a
`deus-native`-side concurrent SubAgent primitive that is *infrastructure a
future fix could build on* — it does not wire any chat channel to
`dispatchSubAgents()`, does not touch the `/deep-research` skill, and does
not make `deus-native` the live default backend. AAG-012's impact row is
unchanged and remains fully open after this change.
