# ADR: Linear pipeline `deus-native` capability boundary (E3/LIA-422)

**Status:** Accepted
**Date:** 2026-07-18
**Scope:** Scopes E3/LIA-422 ("Run the Linear pipeline on deus-native") to what is
safely achievable today, and records the explicit capability guard that
replaces the ticket's original, currently-unsatisfiable acceptance criteria.
**Relates to:** [hook-dispatch-facade-correction.md](hook-dispatch-facade-correction.md)
(C1/LIA-409's wardens enforcement — real but dormant), [deus-v2-langchain-runtime.md](deus-v2-langchain-runtime.md)
(the `SAFE_TOOL_NAMES` web-only boundary), [deus-v2-replay-safety.md](deus-v2-replay-safety.md)
(the idempotency contract any future mutating tool must implement)
**Deciders:** Deus Engineering

---

## Context

E3/LIA-422's original acceptance criteria assumed C1 (LIA-409, wardens
middleware) and C2 (verdict-storage workspace roots) already made
`deus-native` safe to run real Linear pipeline coding work through — select
`deus-native` as the pipeline's backend, have every dispatched issue's commits
pass through C1's gates, and complete an end-to-end coding fixture.

A plan-reviewer round correctly blocked an early attempt at this ticket: the
premise didn't hold. `src/agent-runtimes/tool-broker-langchain-adapter.ts`'s
`DEUS_NATIVE_SAFE_TOOL_NAMES` exposes exactly `web_search`/`web_fetch` —
`deus-native` has no `apply_patch`, no commit-capable `Bash`. The Linear
pipeline dispatcher's `runIssue`/`executeAgentRun` path (`src/linear-dispatcher.ts`)
always ends with "implement the plan, commit what is done" — real
coding-and-commit work `deus-native` cannot perform today. Selecting it as the
pipeline backend without a guard would dispatch a real Linear issue to an
agent with zero mutating tools: a silent no-op that could still emit
`agent_started`/`agent_completed` and advance the issue, misreporting success.

Separately (LIA-445), `hook-dispatch-facade-correction.md` was reconciled to
state precisely: C1's wardens `wrapToolCall` enforcement is real and
production-wired into `deus-native-backend.ts`'s `runTurn`, but its trigger
(`apply_patch`/commit-shaped `Bash`) is dormant because those tool names are
never exposed on the live tool surface.

## Decision

1. **Backend selection and role loading needed no new work.** Both already
   exist generically: `resolveAgentRuntime()` (`src/agent-runtimes/resolve.ts`)
   resolves a task override, then a group `containerConfig.agentBackend`
   override, then the global default — the same mechanism F3/LIA-425 used
   for channel-level backend opt-in. `loadRoleSpecs()`
   (`src/linear-dispatcher.ts`) loads role frontmatter/content before
   runtime resolution, identically regardless of backend.

2. **A new capability-readiness contract gates `deus-native` dispatch.**
   `src/agent-runtimes/deus-native-pipeline-readiness.ts` defines:
   `assessDeusNativeCapabilityReadiness()` (worktree-independent: does the
   live tool surface include read/mutate/commit tools, is the wardens layer
   enabled), `assessDeusNativePipelineReadiness(worktreePath)` (adds the
   worktree-presence check), and `probeDeusNativePipelineReadiness(worktreePath)`
   (adds the one dynamic check — can the warden gate script itself load).
   `src/linear-dispatcher.ts`'s `pollLinear()` runs the worktree-independent
   check for every candidate issue, before creating a worktree or consuming
   a queue slot, and ONLY when the resolved backend is `deus-native`
   (container/Claude backends are unaffected).

3. **Refusal, not silent no-op.** A capability-blocked issue is parked in
   Manual Review Required (falling back to Backlog), labeled
   `runtime:capability-blocked`, commented with the specific missing
   capabilities, and recorded via a distinct `agent_capability_blocked` event
   — mirroring the existing `agent_timeout` parking precedent
   (`linear-dispatcher.ts`'s infra-timeout branch): never counted as an
   agent failure, never touching circuit-breaker accounting. A stale label
   is cleared once dispatch actually proceeds.

4. **E3's original AC3 ("C1 gates execute for every applicable issue") and
   AC6 ("an end-to-end pipeline fixture completes") are deferred, not
   satisfied.** Neither is achievable without real mutating tools. They are
   replaced by: an oracle proof that C1 gates fire correctly IF a protected
   call were made (`middleware-stack.warden-gates.oracle.test.ts`, unchanged
   — this is a mechanism proof, not a live Linear commit test), and a
   hermetic refusal fixture (`linear-dispatcher.test.ts`) proving the guard
   itself: role spec loads, native runtime resolves, `runTurn()` is never
   called, no worktree is created, no false-success event fires.

5. **The tool-widening work is out of scope for E3, filed as AAG-017.**
   Widening `DEUS_NATIVE_SAFE_TOOL_NAMES` to include real mutating tools
   requires the `deus-v2-replay-safety.md` claim/completion idempotency
   contract (durable CLAIM-before/COMPLETE-after writes keyed on
   `thread_id + step + node + tool_call_id`) plus a worktree-confined,
   isolated tool surface (not the existing `bash_exec`, which runs on the
   host with no resource boundary) — a materially larger, security-sensitive
   project deserving its own dedicated plan review, not a side effect of
   this ticket.

## Why not build the tool surface now (Option B)

Sketched and rejected as this ticket's scope: it would require a new
isolated workspace-tool layer, extended permission-rules classification for
every new tool, the full replay journal (claim/complete durable writes,
concurrent-claim collision tests, crash-injection tests at every persistence
boundary), and only then activation of the real C1/C2 gates and completion
fixture. Size/risk: large to extra-large, security-sensitive, multiple
review rounds likely — the hard part is not the dispatcher, it is safely
running model-selected code and surviving LangGraph's always-active
pending-writes replay without duplicate side effects. Tracked as AAG-017's
exit criteria for whoever picks it up next.

## Consequences

### Positive
- The pipeline never silently misreports success for a backend that cannot
  actually do the work.
- `deus-native` is genuinely selectable for the Linear pipeline today
  (config-only, zero code) for whichever future day the tool surface is
  ready — the guard clears itself automatically once AAG-017 lands, no
  dispatcher change required.
- The scope correction is explicit and reviewable, not a quietly green test
  suite masking two unmet original acceptance criteria.

### Negative / accepted
- E3/LIA-422 does not deliver a working `deus-native` Linear coding path
  today. That capability now depends on AAG-017's separate, larger project.
- The capability-readiness contract adds a small amount of always-current
  bookkeeping (checking `DEUS_NATIVE_SAFE_TOOL_NAMES` membership on every
  poll cycle candidate) rather than a one-time flag — an accepted tradeoff
  for staying correct automatically once the tool surface changes, without
  needing this guard code touched again.

## Reversibility

Fully reversible and low-risk: the guard only prevents a dispatch that would
otherwise silently fail today. Removing `deus-native` as a selectable backend
option, or removing the guard once AAG-017 lands, are both single, localized
changes with no data migration.

## References

- Linear tickets: LIA-422 (E3), LIA-445 (the reconciliation that unblocked
  this plan), AAG-017 (the dependent tool-widening work).
- Source: `src/agent-runtimes/deus-native-pipeline-readiness.ts`,
  `src/agent-runtimes/tool-broker-langchain-adapter.ts` (`DEUS_NATIVE_SAFE_TOOL_NAMES`),
  `src/agent-runtimes/middleware-stack.ts` (`probeWardenGateIntegration`),
  `src/linear-dispatcher.ts` (`resolveLinearDispatchReadiness`,
  `refuseCapabilityBlockedIssue`, `pollLinear`).
- Tests: `src/agent-runtimes/deus-native-pipeline-readiness.test.ts`,
  `src/agent-runtimes/middleware-stack.test.ts` (`probeWardenGateIntegration`
  suite), `src/linear-dispatcher.test.ts` (backend selection, role
  preservation, and capability-blocked refusal suites).
