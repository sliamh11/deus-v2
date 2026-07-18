# Deus v2: Chat-Reachable SubAgent Dispatch — Role Catalog (LIA-444)

**Status:** Accepted
**Date:** 2026-07-18
**Scope:** `src/agent-runtimes/nested-dispatch-tool.ts`, `src/agent-runtimes/deus-native-backend.ts`
**Related:**

- `deus-v2-subagent-dispatch.md` — B8/LIA-408's `createNestedDispatcher()`
  and the parent-facing `dispatch_nested_agent` tool this ADR modifies.
- `deus-v2-subagent-dispatch-primitive.md` — E1/LIA-420's generic
  `.claude/agents/*.md` loader (`agent-spec-loader.ts`,
  `loadAgentSpecs()`/`buildAgentSpecDispatchRequest()`) and LIA-421's
  `.claude/agents/researcher.md` role, both built but with **zero
  production callers** until this ticket. That ADR's own scope note is
  explicit: "Does NOT wire into `DeusNativeRuntime.runTurn()`, add
  chat-intent detection, or close AAG-012's chat-unreachability impact —
  infrastructure only, no new chat-reachable entrypoint." This ADR is that
  follow-up.
- `docs/agent-agnostic-debt.md` (AAG-012) — the `/deep-research` skill gap
  this ticket partially mitigates for `deus-native` specifically (see the
  updated AAG-012 row for the precise, narrowed scope of that mitigation).

## Context

Before this ticket, `dispatch_nested_agent` was already wired into every
`deus-native` chat turn (`deus-native-backend.ts` builds the tool and passes
it to `createAgent`'s tool list unconditionally) — the parent model could
already call it autonomously from any chat message. But the tool's `agentId`
argument was purely a tracing label: the adapter never consulted
`.claude/agents/*.md`, so even a call naming `"researcher"` produced a raw,
parent-invented prompt and result schema, never the role's actual checked-in
methodology. Separately, `loadAgentSpecs()`/`buildAgentSpecDispatchRequest()`
(E1/LIA-420) and `.claude/agents/researcher.md` (LIA-421) already existed and
were unit-tested, but had no production caller anywhere.

## Decision

Make the existing, already-production-wired `dispatch_nested_agent` tool
role-aware: when the parent model's `agentId` argument matches a checked-in,
production-allowlisted role, Deus's own role prompt, canonical model, and
output contract become authoritative instead of whatever the parent supplied.

Explicitly rejected: a deterministic `/dispatch <role> <task>` chat command,
and an automatic intent classifier that would auto-route messages containing
research-like language to the researcher role without an explicit model
decision. Both were considered and rejected — the classifier approach was
already deliberately deferred by LIA-421 (`detectDeepResearchIntent()`) as
"too invasive to wire in blind pending a concrete consumer," and a slash
command would require a new backend-visible command contract, a separate
CLI/channel interception path, and its own authorization/checkpoint/transcript
design — materially larger than closing the existing role-spec wiring gap.
Tool selection therefore remains model-mediated: an explicitly worded chat
request ("delegate this to the researcher role...") is what triggers a real
dispatch, not a keyword match or a slash command.

### Security: an explicit allowlist, not the full role catalog

`loadAgentSpecs()` loads every direct `.claude/agents/*.md` file — 28+ specs
today, including internal pipeline/gate agents (`code-reviewer`,
`plan-reviewer`, `ai-eng-warden`, `threat-modeler`, `verification-gate`,
etc.) whose prompts assume a diff/plan review context, not arbitrary chat
delegation. None of these specs carry any frontmatter field distinguishing
"safe to expose to an end chat user" from "internal reviewer/gate agent."
Exposing the full, unfiltered catalog as chat-dispatchable roles would leak
the internal agent roster and risk capability confusion or misleading "gate"
verdicts if invoked outside their intended pipeline context.

`deus-native-backend.ts` therefore filters `loadAgentSpecs()`'s result
through an explicit, hardcoded `PRODUCTION_CHAT_DISPATCHABLE_ROLES` allowlist
(currently `{'researcher'}`) BEFORE ever passing it to the dispatch tool —
the tool adapter itself trusts the map it's given completely and never sees
the unfiltered catalog. Adding a future chat-dispatchable role is a
deliberate, reviewed edit to that allowlist constant, not an automatic
consequence of adding a new `.claude/agents/*.md` file. A frontmatter-based
opt-in flag (e.g. `chat_dispatchable: true`) was considered and explicitly
deferred as premature for a single-role catalog — proportionate if/when the
allowlist grows past a couple of roles.

`loadAgentSpecs()` also throws `FatalError` if ANY direct role spec is
malformed, even one wholly unrelated to chat dispatch. The runtime
constructor catches this and falls back to an empty filtered catalog (chat
SubAgent dispatch becomes unavailable, logged, but the whole runtime still
constructs) rather than letting one unrelated malformed warden spec crash
`DeusNativeRuntime` entirely.

### Design correction found during implementation: one schema, not two

The original implementation plan proposed two mutually-exclusive tool
modes selected by whether a catalog was supplied — a "generic" schema
(parent supplies `model`/`outputContract`, any `agentId` string, no role
prompt injected) and a narrower "catalog" schema (`agentId`/`prompt` only,
Deus owns everything else). Building this as designed and running the
pre-existing `deus-native-model-selection.integration.test.ts` suite
surfaced a real regression: LIA-411 already lets a parent dispatch an
arbitrary `agentId` (e.g. `"plan-reviewer"`, `"verification-gate"`) purely
for MODEL-TIER selection via `resolveEffectiveModelId`/`wardenRoleModels` —
no real role prompt is loaded for these, just a matching Claude model alias.
Since production always supplies a non-empty `agentSpecs` map (even with
just `{researcher}` in it), a strict two-schema split would have switched
the ENTIRE tool into catalog-only mode for every dispatch, rejecting any
`agentId` outside the one-role allowlist as "unknown" — breaking this
already-shipped, unrelated capability.

The corrected, shipped design uses ONE schema and ONE handler for both
cases: the parent-visible schema keeps requiring `agentId`/`model`/`prompt`/
`outputContract` exactly as before (full backward compatibility), and the
handler checks catalog membership FIRST. A match (only `"researcher"` today)
substitutes Deus's own prompt/model/contract, ignoring the parent's `model`/
`outputContract` arguments for that call. No match falls through UNCHANGED
to the original LIA-408/LIA-411/LIA-429 generic path — model-tier selection
for arbitrary role names keeps working exactly as it did before this ticket.
The tool's `agentId` field description is extended with a bounded, sorted
"known specialized roles" catalog listing (built from the allowlist-filtered
map only) so the parent model can discover `"researcher"` as a real,
checked-in role — this is the "chat-trigger" surface: any chat message the
model reads can now result in a genuine researcher dispatch, without a new
command contract.

## Consequences

- `dispatch_nested_agent` calls naming an allowlisted role now use the
  role's real methodology and a validated `{content: string}` output
  contract, regardless of what the parent model supplied for
  `model`/`outputContract`.
- Every other `agentId` (unknown, or a real-but-non-allowlisted role like
  `"code-reviewer"`) behaves exactly as before this ticket — the generic
  path, unchanged.
- No heuristic classifier, slash command, automatic fan-out, or synthesis
  middleware was added. `dispatchSubAgents()` (LIA-421's concurrent batch
  primitive) is untouched — this ticket's dispatch remains one model-selected
  call per turn, not an application-driven batch.
- AAG-012 (`/deep-research` chat-unreachability) is partially mitigated for
  `deus-native` specifically — see the updated debt-tracker row for the
  precise, narrowed scope (single-role, model-mediated, no fan-out, no
  NotebookLM — not the full skill).

## Rollback

Single revert: restore the pre-LIA-444 `nested-dispatch-tool.ts` (no
`agentSpecs` parameter, no catalog branch) and drop `deus-native-backend.ts`'s
`agentSpecs` field/allowlist/`loadFilteredAgentSpecs()` call. The tool
continues to function exactly as it did before this ticket for every
existing caller.
