# Deus v2: Replay Safety for the deus-native Checkpointed Loop (B5)

**Status:** Accepted
**Date:** 2026-07-15
**Scope:** Documentation + one regression test
(`src/agent-runtimes/deus-native-checkpointer-integration.test.ts`). No
runtime code changes — this ADR records a verified audit finding and defines
the contract future work (B7/LIA-407) must implement against.
**Related:**
- `deus-v2-langchain-runtime.md` — its Decision 3 establishes the
  conservative `SAFE_TOOL_NAMES` web-only tool surface this ADR's
  current-safety finding builds on. Not superseded.

## Context

B5 (LIA-405)'s literal ticket text asks to "audit Bash, write, git, and
Linear mutation paths" and "node-wrap non-idempotent tools" in the
`deus-native` backend. Independent verification (below) shows the tool half
of that description is a FUTURE state: no mutating tool is reachable from
deus-native's agent loop today. But the underlying REPLAY MECHANISM the
ticket warns about is real, verified, and always-active — not gated behind
an opt-in interrupt/resume API as originally assumed. B5 therefore becomes:
document the verified mechanism and current-safety finding, prove the one
real idempotency property with a frozen regression test, and define the
idempotency contract B7 must implement when it wires real mutating tools —
rather than auditing or node-wrapping tools that don't exist yet
(core-behavioral-rules.md: don't solve problems that don't exist yet).

B4 (LIA-404, checkpointer-backed session persistence) already shipped
(commit b3eca7b0) with its own module doc comment in
`src/agent-runtimes/deus-native-backend.ts` explicitly deferring
"Replay-safety auditing (B5/LIA-405)" as a stated non-goal — the team
already decided not to block B4's sign-off on this ticket. This ADR is the
follow-up B4's doc comment anticipated.

All `node_modules` line citations below are pinned to
`@langchain/langgraph@1.4.7` (per `package-lock.json`) and were each
verified by reading the installed source directly. Re-verify them on any
LangGraph upgrade.

## Decision

### 1. Today's tool surface is read-only — zero live mutation-replay risk

deus-native exposes exactly two tools: `SAFE_TOOL_NAMES = new
Set(['web_search', 'web_fetch'])`
(`src/agent-runtimes/tool-broker-langchain-adapter.ts:124`), enforced by
`buildSafeTools`'s inclusion filter (`tool-broker-langchain-adapter.ts:251-261`),
which drops every other broker tool before the agent loop ever sees it. Both
are read-only. Zero Bash/write/git/Linear mutation tools are reachable from
deus-native's agent loop today, so no node-wrapping is performed by this
ticket — there is nothing to wrap (the ticket's node-wrapping AC is
explicitly N/A today; the Section 4 contract gates B7's future work
instead).

**`web_search` and `web_fetch` are intentionally replayable.** They perform
no side effect, so re-executing either on a crash-recovery replay is safe by
construction. They are documented here as the complete list of
approved-replayable operations; any tool added later must either be
similarly side-effect-free or implement the Section 4 contract.

### 2. The verified replay mechanism (and the real hazard)

LangGraph's pending-writes reapplication is active on EVERY ordinary
invoke — it is not gated behind the interrupt/resume API:

- `skipDoneTasks = config.configurable ? !("checkpoint_id" in
  config.configurable) : true`
  (`node_modules/@langchain/langgraph/dist/pregel/loop.js:238`) — `true` for
  every ordinary `agent.invoke({ configurable: { thread_id } })` call, which
  is deus-native's own, exclusive call pattern (it never passes
  `checkpoint_id`).
- `checkpointPendingWrites = saved.pendingWrites ?? []` (`loop.js:283`)
  loads unconditionally on every `initialize()`, regardless of resume
  status.
- In `tick()` (`loop.js:496-505`): when `skipDoneTasks &&
  checkpointPendingWrites.length > 0`, any persisted pending write matching
  a freshly-computed task id is reapplied to that task INSTEAD of
  re-executing the node.

This is safe crash recovery when a task's write was durably persisted
before the crash: the node is skipped and its recorded write reapplied. The
hazard is the complementary window: a tool node's real-world side effect
fires BEFORE its write is durably persisted (checkpoint commit granularity
is per-superstep). **If the process crashes strictly between the tool's
real side effect and that write's persistence, the NEXT ordinary invoke for
that `thread_id` — no interrupt/resume needed — finds no pending write for
the task and re-executes the node from scratch: a genuine duplicate
mutation.** This is an inherent at-least-once execution hazard for ANY
mutating tool under this checkpointer. It is present in the MECHANISM today
even though zero mutating tools exist yet to trigger it.

### 3. Disposition of the existing write paths

The two non-tool writes in the deus-native path are already idempotent:

- **Checkpointer** (`src/agent-runtimes/checkpointer.ts`): the `SqliteSaver`
  writes are LangGraph's own internal checkpoint-commit mechanism —
  idempotent by SqliteSaver's own design (checkpoint puts are keyed upserts
  on thread/namespace/checkpoint id; replaying a persisted write is the
  designed recovery path described in Section 2, not a duplication).
- **`db.setSession`** (`src/db.ts:791-830`): idempotent by its own
  dedup-on-existing-row logic — when the active row for `(group_folder,
  backend)` already matches the incoming `session_id`/`resume_cursor`/
  `metadata_json`, it only touches `last_used_at` instead of orphaning and
  inserting. Re-running the same session save is a no-op on row identity.

The AC4 regression test in
`src/agent-runtimes/deus-native-checkpointer-integration.test.ts` freezes
the `setSession` property: invoking the same `thread_id` twice in a row
with an already-existing session leaves exactly ONE row in `sessions` for
`(groupFolder, backend)`, with `id` (the autoincrement primary key — the
`sessions` schema at `src/db.ts:83-93` has no `created_at` column)
unchanged and `last_used_at` advanced.

### 4. REQUIRED contract for any future mutating tool (gates B7/LIA-407)

Any mutating tool wired into deus-native MUST be wrapped so that the
wrapper performs **two atomic durable writes around the mutation** — a bare
read-check before mutating is NOT sufficient (see Alternatives):

1. **CLAIM write** (key → `"attempting"`), committed durably BEFORE the
   mutation fires.
2. **COMPLETION write** (key → `"done"`, with the recorded result),
   committed durably immediately AFTER the mutation succeeds.

On any replay: key absent → safe to claim and mutate; key `"done"` → return
the recorded result and skip the mutation; key `"attempting"` (crashed
mid-flight) → see the residual window below.

**Key = `thread_id + step + node name + within-step call identity`.** The
call-identity component is `tool_call_id` WHEN PRESENT — but the contract
MUST NOT assume it is always present: `ToolCall.id` is declared optional
(`node_modules/@langchain/core/dist/messages/tool.d.ts:92-97`: `id?:
string`), and LangGraph itself explicitly handles the null case
(`node_modules/@langchain/langgraph/dist/prebuilt/react_agent_executor.js:279`
filters `pendingToolCalls` with `i.id == null || ...`). When absent, the
wrapper falls back to this tool call's ordinal INDEX within the triggering
AIMessage's `tool_calls` array for that step — a durable, deterministic
value available at call time, since that array is exactly what
`react_agent_executor.js` iterates to build the tool fan-out.

Why per-call identity is load-bearing: `react_agent_executor.js` dispatches
EVERY tool call the model requests in one turn as a separate Send-based
task at the SAME graph step (`pendingToolCalls.map((toolCall) => new
Send("tools", {...}))`, `react_agent_executor.js:282,305`), so `thread_id +
step` alone would collide between two mutating tool calls in the same turn
— exactly the duplicate/skipped-mutation class of bug this contract exists
to prevent. Whichever component is used (id or index), it cannot collide
within a turn. (This key is justified on its own merits; it deliberately
does NOT mirror LangGraph's internal task-id scheme, which disambiguates
Send tasks by an ordinal array index —
`node_modules/@langchain/langgraph/dist/pregel/algo.js:352-374` — a less
legible mechanism than `tool_call_id`.) The wrapper must also NOT infer
safety from whether the current invoke is "resuming" vs "fresh": per
Section 2, the hazard fires on ordinary, non-resumed invokes.

**Scope note (subgraphs):** this key omits `checkpoint_ns`. LangGraph's own
task identity threads `checkpoint_ns` through as well
(`node_modules/@langchain/langgraph/dist/pregel/loop.js:284-288`), because
subgraph nesting can put two different logical tasks at the same
`(step, node)` pair. Not a defect today — deus-native has no subgraphs — but
this key stops being unique the moment subgraph nesting is introduced; add
`checkpoint_ns` to the key before that lands.

**Open question (concurrency):** this contract reasons about sequential
crash-then-replay (one `runTurn` call finishes or crashes before the next
begins). Whether deus-native's callers guarantee this today (e.g. via
`GroupQueue`'s per-group serialization, `src/group-queue.ts`) was NOT
independently verified as part of this ADR — confirm before B7 relies on
it; a genuinely concurrent pair of `invoke()` calls on the same `thread_id`
is a different, unaddressed hazard class.

**Documented residual window (not fully closeable locally):** a crash
strictly between the external mutation succeeding and the local COMPLETION
write committing leaves the key at `"attempting"` — the replay cannot know
whether the mutation happened. This dual-write gap is inherent to ANY
local-claim + external-mutation pair; only the downstream system can make
that window atomic. B7 should therefore prefer downstream APIs that accept
a passed-through idempotency key wherever available (pass this contract's
key through), and treat the local claim/complete pair as the floor, not a
complete solution. An `"attempting"` key on replay must surface for
resolution (e.g. query the downstream system, or fail loudly) — never
silently re-mutate. In practice this splits into two buckets: tools backed
by a queryable API (e.g. Linear) can resolve an `"attempting"` key by
querying the downstream system for the mutation's actual outcome; tools
with no such query path (Bash, git -- you cannot ask a shell command "did I
already run") have no automatic resolution and MUST fail loudly for manual
intervention. B7 should design each tool wrapper knowing which bucket it
falls into up front, not discover it during implementation.

## Alternatives Considered

- **Implement the claim/complete wrapper mechanism now.** Rejected: real
  infrastructure with no caller — B7 hasn't landed any mutating tool this
  would wrap. Speculative infrastructure without a real caller is waste
  (core-behavioral-rules.md). This ADR defines the contract; B7 implements
  against it.
- **Infer safety from resume-vs-fresh invoke status.** Rejected: the
  crash-recovery hazard fires on ordinary, non-resumed invokes
  (`skipDoneTasks` is `true` on every deus-native call, `loop.js:238`), so
  resume status carries no safety signal.
- **A bare check-then-act read-check before mutating.** Rejected: a crash
  strictly AFTER the real side effect fires but BEFORE the check result is
  durably recorded reproduces the exact same hazard one layer down — the
  next replay finds no record and mutates again. Hence the two-write
  claim/complete contract.
- **Key = `thread_id + step` alone.** Rejected: every tool call in a turn
  fans out to a separate task at the SAME step
  (`react_agent_executor.js:282,305`), so two mutating calls in one turn
  would collide.
- **Assume `tool_call_id` is always present.** Rejected: `ToolCall.id` is
  optional (`tool.d.ts:92-97`) and the library explicitly handles the null
  case (`react_agent_executor.js:279`); hence the ordinal-index fallback.

## Consequences

- B7 (LIA-407) must implement the Section 4 contract before wiring any
  mutating tool into deus-native — this stacks on
  `deus-v2-langchain-runtime.md`'s existing rule that widening the tool
  surface requires the permission engine plus its own review.
- `web_search`/`web_fetch` remain intentionally replayable; no wrapper is
  added for them.
- One frozen regression test pins `setSession`'s dedup idempotency; the
  checkpointer's own idempotency rests on SqliteSaver's design and needs no
  Deus-side test.
- The residual `"attempting"` window is an accepted, documented risk until
  downstream idempotency-key passthrough exists per mutating tool.
- Where claim/complete records live (a new table, reuse of an existing one,
  TTL/cleanup policy) is intentionally left to B7's implementation -- an
  open design question this ADR does not resolve, flagged here so it isn't
  discovered mid-implementation.
- The LangGraph line citations are version-pinned (`@langchain/langgraph@
  1.4.7`); a future upgrade that changes `loop.js`'s pending-writes
  semantics invalidates Section 2 and requires re-verification before B7
  builds on it.

## Rollback

Documentation-only: delete this file, its `docs/decisions/INDEX.md` row, and
the AC4 test block in
`src/agent-runtimes/deus-native-checkpointer-integration.test.ts` (plus the
`_`-prefixed test-only raw-row accessor in `src/db.ts` if nothing else has
adopted it). No runtime behavior changes are involved.
