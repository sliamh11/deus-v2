# Deus v2: Declarative Permission Rules and Read-Only Profiles (B7)

**Status:** Accepted
**Date:** 2026-07-15
**Scope:** `src/agent-runtimes/permission-rules.ts`, `src/agent-runtimes/middleware-stack.ts`, `src/agent-runtimes/deus-native-backend.ts`, comment-only updates in `src/agent-runtimes/tool-broker-langchain-adapter.ts`
**Related:**

- `deus-v2-langchain-runtime.md` — Decision 3 establishes the conservative
  `SAFE_TOOL_NAMES` web-only tool surface (`web_search`/`web_fetch`) as the
  current live boundary and states that widening it requires this ADR's
  permission engine plus its own separate review. This ADR does not widen
  that surface and does not supersede that boundary.
- `deus-v2-replay-safety.md` — Section 4 defines the claim-before/complete-
  after idempotency contract required before any future mutation tool is
  wired into `deus-native`. That contract is a distinct gate triggered by
  future mutation-tool wiring, not by permission-policy evaluation; this ADR
  does not restate or alter it.

## Context

The `deus-native` middleware stack (`deus-v2-langchain-runtime.md`, B2/LIA-402)
puts a `permissions` layer at index 0 of `CANONICAL_MIDDLEWARE_ORDER` — the
outermost `wrapToolCall` wrapper around every tool call the agent makes. Since
B2 that layer has been an explicit placeholder: it logs `{ decision: 'allow' }`
for every call and always delegates to the handler unchanged
(`middleware-stack.ts`'s `buildPermissionsMiddleware`, prior to this change).
The placeholder's own doc comment named this ticket, B7/LIA-407, as the
substantive engine that would replace it.

Leaving that placeholder in place has two costs. First, `deus-native` has no
authorization boundary independent of the tool-surface allowlist
(`SAFE_TOOL_NAMES`) — any future mutation tool wired per
`deus-v2-replay-safety.md`'s contract would inherit an allow-all permissions
layer with no deterministic policy to gate it before its idempotency wrapper
even runs. Second, there is no way to construct a deliberately restricted
agent (a read-only mode) for a future plan-mode selector — the roadmap's
LIA-407 ticket text calls for exactly that primitive, gated on a per-call
tool-name decision rather than argument or path inspection.

B7 replaces the placeholder with a pure, deterministic rule evaluator and a
registry of two named profiles (`default`, `read-only`), wired through the
existing `RunContext.backendConfig` seam into `BuildMiddlewareStackDeps` so
production actually constructs the substantive middleware. It intentionally
does not add a third live tool, does not implement HITL edit/approval flows,
and does not decide when a turn is in plan mode — those are separate, later
decisions (see Non-Goals below).

## Decision

### Policy schema and evaluation result (AC1)

`permission-rules.ts` defines the pure policy contract:

- `PermissionDecision`: `'allow' | 'deny'`.
- `PermissionRule`: an exact `toolName` string paired with a `decision`. No
  wildcards, regexes, prefixes, or argument/path-sensitive matching — exact
  tool names are sufficient for this ticket and easier to audit
  deterministically.
- `PermissionPolicy`: an ordered `rules: PermissionRule[]` plus an explicit
  `defaultDecision` applied when no rule matches. There is no implicit
  global fallback outside a policy's own `defaultDecision`.
- `PermissionEvaluation`: the structured result of evaluating a policy against
  a tool name — `decision`, `source` (`'rule'` when an explicit rule matched,
  `'default'` for the fallback), `matchedRuleIndex` (the winning rule's index,
  `undefined` for a default-sourced result), and a `reason` string that is
  safe to surface to the model or to logs. The reason never includes tool-call
  arguments.

`evaluatePermission(policy, toolName)` is a pure function: it inspects only
`policy` and `toolName`, never tool-call arguments, mutable runtime state,
the clock, or the environment. The same `(policy, toolName)` pair always
yields the same result.

### Precedence and per-policy default (AC1/AC4)

Rules are evaluated in declaration order; the **first exact tool-name match
wins**. If no rule matches, the policy's own `defaultDecision` applies. A
policy with contradictory duplicate rules for the same tool name is settled
by position — the earlier rule wins — never by "deny overrides" or "last
rule wins" semantics. There is no default outside a policy: every
`PermissionPolicy` must carry an explicit `defaultDecision`, so an evaluator
call can never silently fall through to an unstated behavior.

### Named profile registry (AC1/AC3)

`PERMISSION_PROFILES` is a `Map<string, PermissionPolicy>` holding exactly two
supported strategies:

- **`default`** — empty `rules`, `defaultDecision: 'allow'`. This
  byte-for-byte preserves today's allow-all permissions behavior when no
  profile is requested; the separate `SAFE_TOOL_NAMES` inclusion filter
  (`tool-broker-langchain-adapter.ts:124`, enforced by `buildSafeTools` at
  `tool-broker-langchain-adapter.ts:251-260`) still limits the actual live
  tool surface to `web_search`/`web_fetch` regardless of this profile.
- **`read-only`** — explicit `allow` rules for the six read tools, explicit
  `deny` rules for the eleven mutation-capable tools (below), and
  `defaultDecision: 'deny'`. Fail-closed: a newly added or dynamically
  loaded tool whose side-effect classification has never been reviewed is
  denied by default rather than silently granted.

`resolvePermissionProfile(name)` is the only path that accepts a _name_ from
live configuration (`RunContext.backendConfig.permissionProfile`, threaded
through `BuildMiddlewareStackDeps`). It throws on an unrecognized name rather
than falling back to a weaker policy — an invalid profile must fail visibly
before agent construction, matching the plan's Scope commitment. Arbitrary
`PermissionPolicy` objects remain a programmatic/test-only input to
`evaluatePermission` directly; they are not accepted from `backendConfig`,
because a loosely validated caller passing raw rule JSON could weaken the
live security policy without the review a new named profile requires.

### Tool catalog partition (AC3)

The container broker defines 17 built-in tools in one array
(`container/agent-runner/src/tool-broker.ts:365-544`). The `read-only`
profile partitions that catalog into:

- **Six reads** (`READ_ONLY_ALLOWED_TOOL_NAMES`): `read_file`, `glob_files`,
  `grep_files`, `web_fetch`, `web_search`, `list_tasks`. Each was verified
  read-only by reading both its definition and its implementation.
- **Eleven mutation-capable tools** (`READ_ONLY_DENIED_TOOL_NAMES`):
  `bash_exec`, `write_file`, `edit_file`, `agent_browser`, `send_message`,
  `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`,
  `register_group`.

`bash_exec` and `agent_browser` are classified as mutation-capable by
**capability, not per-invocation intent**: both expose effectively
unrestricted command surfaces that can cause side effects even when a
specific call only reads, and a name-only evaluator has no way to inspect
intent. Every known tool in the catalog gets an explicit deny rule rather
than relying on the profile's default-deny to cover it, so the
classification of each of the 17 tools is a reviewed, auditable decision —
the default-deny path is reserved for genuinely unknown names (unregistered,
dynamically loaded, or future MCP tools). Catalog parity — that all 17
appear exactly once across the two lists, that every read evaluates to
allow, every mutation to deny, and an unknown name to deny — is pinned by an
independently authored oracle test (`permission-rules.oracle.test.ts`; see
below) against the live broker definitions, not a hardcoded count, so
catalog drift fails loudly.

### Denial mechanism (AC2/AC5)

`buildPermissionsMiddleware`'s `wrapToolCall` evaluates
`request.toolCall.name` against the resolved policy. On **allow**, it records
the decision and calls `handler(request)` exactly once with the original,
unmodified request object. On **deny**, it records the decision and returns a
synthetic `ToolMessage` — carrying the original tool name and tool-call id,
`status: 'error'`, and stable content identifying `permission_denied`, the
active profile, and the evaluation's `reason` — **without ever calling the
handler**. Denial content deliberately omits the tool-call's arguments, so a
blocked call does not re-expose potentially sensitive values while still
telling the model what was blocked and why, so it can continue without that
tool.

This follows LangChain's own installed authentication example for
`wrapToolCall` (deny by returning a synthetic `ToolMessage` without invoking
the handler; allow by calling `handler(request)`), which keeps denial
feedback inside the model's normal ReAct loop instead of throwing or routing
through the HITL `Command`/interrupt machinery.

### HITL edit-decision boundary is out of scope (AC5)

The only two outcomes on the permission path are: allow via
`handler(request)` with the original, unmodified request, or reject/respond
via a denial `ToolMessage` with no delegation. No LangChain HITL middleware,
interrupt, approval flow, or edit decision is imported or instantiated
anywhere on this path, and no code on this path reconstructs or replaces the
tool-call request (no `handler({ ...request })` pattern).

This is a deliberate scope boundary, not an oversight: as of 2026-07-15,
[`langchain-ai/langchain#33787`](https://github.com/langchain-ai/langchain/issues/33787)
remains open and describes an HITL `edit` decision causing the original,
unedited tool call to be attempted again instead of the edited one — the
edit semantics are not reliable in the installed LangChain version. Building
an edit/rewrite permission path on top of a known-broken upstream mechanism
would ship a security-adjacent feature that silently does not do what its
name implies. HITL edit/rewrite support is deferred until that upstream
issue is resolved and a separate ticket approves the semantics; deterministic
allow/deny policy enforcement has no dependency on it.

### Design: Chain of Responsibility + Registry

- **Chain of Responsibility — ordered rules, first match wins.**
  `evaluatePermission` walks `policy.rules` in declaration order and stops at
  the first match; this is the ordered, firewall-style behavior described
  above. A linear rule array preserves that ordering and costs O(n) per
  decision. For the `read-only` profile, n is bounded by the fixed 17-tool
  built-in catalog, so a lookup index would add synchronization risk
  (rules array vs. index going out of sync) without a meaningful runtime
  benefit at this scale.
- **Registry — named policy lookup.** `PERMISSION_PROFILES` is a
  `Map<string, PermissionPolicy>` giving O(1) average-case named-profile
  lookup while keeping arbitrary policy objects off the live `backendConfig`
  input path. Adding a future reviewed profile (e.g. a narrower
  tool-specific profile) extends the registry without changing
  `evaluatePermission`'s control flow.
- **Pure evaluator, thin adapter.** Policy evaluation
  (`evaluatePermission`) has no side effects; the LangChain `wrapToolCall`
  middleware in `middleware-stack.ts` is a thin adapter that calls the
  evaluator, records the result, and either delegates to `handler` or
  returns a denial `ToolMessage`. This keeps the security decision
  independently testable without a LangChain agent in the loop, and keeps
  the framework-integration code free of policy logic.

### Independent oracle before implementation

Because this changes the tool-execution authorization boundary, the plan
required invoking the `oracle-author` Warden **before** `permission-rules.ts`
or any production-code change, giving it only the LIA-407 specification and
pre-existing public surfaces — never an implementation diff. It independently
authored two failing, executable tests for the two highest-risk invariants:

1. `permission-rules.oracle.test.ts` — an `@oracle` catalog-parity test
   proving the real 17-tool broker catalog partitions exactly once into the
   six reads and eleven mutation-capable tools, each read evaluates to
   allow, each mutation to deny, and an unknown tool to deny.
2. `middleware-stack.oracle.test.ts` — an `@oracle` deny-path test proving a
   denied call never invokes the underlying handler and produces the
   specified model-visible denial `ToolMessage` without exposing arguments.

The implementation was required to confirm both oracle files are red against
the pre-implementation tree, then make them green without weakening,
untagging, or rewriting their expectations; a genuinely incorrect oracle may
only be changed by the oracle author or reviewer, with the reason recorded.
The allow-path frozen/nested request-identity test remains
implementation-authored, since it verifies adapter construction rather than a
security decision — the independently authored catalog and non-delegation
tests cover the invariants most vulnerable to correlated
implementer/test blind spots.

### Reversibility and rollback

This change is **REVERSIBLE** and default-preserving. It introduces no
data/schema migration and does not widen `SAFE_TOOL_NAMES`. Omitting
`backendConfig.permissionProfile` selects the `default` allow-all policy,
which matches today's behavior exactly. If a caller sees unexpected denials
after selecting `read-only`, removing `permissionProfile: 'read-only'`
restores today's behavior immediately, with no deployment-order dependency.
The full code change can be rolled back with a single-commit revert: delete
`permission-rules.ts` and its tests, and restore `buildPermissionsMiddleware`
to its prior allow-all-and-log form in `middleware-stack.ts`.

## Alternatives Considered

- **Deny-overrides or last-match-wins rule precedence.** Rejected in favor
  of first-match-wins: ordered, firewall-style evaluation is simple,
  deterministic, and makes an intentional exception visible by its placement
  in the array. A contradictory-duplicate-rule regression test pins
  first-match precedence so a future change cannot silently switch semantics.
- **Read-only profile defaults to allow for unknown tools.** Rejected: a
  plan-mode primitive must not silently grant a newly added or dynamically
  loaded tool whose side-effect classification has never been reviewed.
  Fail-closed default-deny makes a maintenance failure (an unclassified new
  tool) loud instead of silently permissive.
- **Accept arbitrary rule JSON through `backendConfig`.** Rejected: a
  loosely validated caller could weaken the live security policy directly,
  and supporting that would require a materially larger
  configuration/validation contract than this ticket scopes. Named profiles
  keep the live-configurable surface to two reviewed strategies; arbitrary
  `PermissionPolicy` objects remain available programmatically for tests and
  future internal callers.
- **Throw an authorization error, or return a `Command`, on denial.**
  Rejected in favor of a synthetic `ToolMessage` with `status: 'error'`:
  LangChain's installed authentication example uses exactly this pattern,
  and it keeps denial feedback inside the model's normal ReAct loop rather
  than unwinding the stack or invoking HITL control flow the ticket
  deliberately avoids.
- **Implement HITL edit-decision support now, alongside allow/deny.**
  Rejected: the installed LangChain version's HITL `edit` decision is
  documented as unreliable upstream (`langchain-ai/langchain#33787` — the
  original unedited call can be re-attempted instead of the edited one).
  Shipping an edit path on a known-broken mechanism would be worse than not
  shipping it; deferred until the upstream issue resolves and a separate
  ticket approves the semantics.
- **Speculative custom rule matching (argument-sensitive, path-sensitive,
  wildcard/regex, user/group-specific).** Rejected as premature: exact tool
  names are sufficient for this ticket's read-only primitive and are easier
  to audit deterministically; no caller today needs finer-grained matching
  (core-behavioral-rules.md: don't solve problems that don't exist yet).

## Rationale

The chosen design is preferred given the context above for both objective and
subjective reasons.

**Objective:** the evaluator's determinism and O(n)/O(1) cost bounds are
verifiable properties, not preferences — the same `(policy, toolName)` input
always produces the same output, and both the rule-array walk and the
profile-map lookup are bounded by the fixed 17-tool catalog. The
`ToolMessage`-based denial mechanism is dictated by LangChain's own installed
`wrapToolCall` contract (`node_modules/langchain/dist/agents/middleware/types.d.ts`),
not by taste. The HITL deferral is dictated by a verified, currently-open
upstream defect, not by a scope preference alone.

**Subjective:** the named-profile-only live-configuration boundary (versus
accepting arbitrary rule JSON) is a judgment call trading configurability for
auditability — a reasonable engineer could instead choose a validated
JSON-schema path for custom policies; that was rejected here on
maintainability grounds, not because it's provably unsafe. Likewise,
capability-based classification of `bash_exec`/`agent_browser` as
mutation-capable (rather than attempting per-invocation intent detection) is
a conservative default that a future finer-grained sandbox could revisit.

## Consequences

**Positive:**

- `deus-native`'s `permissions` middleware layer changes from an observe-only
  placeholder to a real, testable authorization decision point, independent
  of the tool-surface allowlist.
- A read-only agent configuration is now constructible
  (`permissionProfile: 'read-only'`), which is the primitive a future
  plan-mode selector needs — without that later ticket needing to touch the
  evaluator or profile registry.
- `ToolCallDecisionRecord` gains a real `allow | deny` decision plus
  source/reason, so tests and future observability can inspect actual
  enforcement outcomes instead of an always-`allow` log.
- The evaluator is pure and independently unit-testable without constructing
  a LangChain agent.

**Negative:**

- Two more named-profile-shaped pieces of state (`DEFAULT_POLICY`,
  `READ_ONLY_POLICY`) must be kept in sync with the broker's tool catalog by
  hand; a broker tool addition that is not reflected in
  `READ_ONLY_ALLOWED_TOOL_NAMES`/`READ_ONLY_DENIED_TOOL_NAMES` falls through
  to `read-only`'s default-deny (safe) but silently omits the new tool from
  the reviewed classification lists (a latent documentation gap, not a
  security gap, given fail-closed default).
- The registry only supports two profiles today; any team that wants a
  narrower or wider named profile must land it as a reviewed code change to
  this file, not a configuration change.

**Risks:**

- If a future broker tool addition is missed in both the oracle test's
  broker-derived assertions and this ADR's catalog list, the drift would
  only be caught by the next run of the independent oracle test — not at
  broker-definition time.
- The `default` profile's allow-all `defaultDecision` means the permissions
  layer still enforces nothing by default; the actual live boundary remains
  `SAFE_TOOL_NAMES`. A future change that widens `SAFE_TOOL_NAMES` without
  also switching the active profile to something narrower than `default`
  would not be caught by this ADR's mechanism — it relies on
  `deus-v2-langchain-runtime.md`'s separate rule that widening the tool
  surface requires its own review.

**Precondition for the first mutating-tool ticket** (flagged by threat-model
review, LIA-407): the permission engine is opt-in defense today, not the
enforcing boundary — `backendConfig.permissionProfile` has no production
caller yet, so nothing currently selects `read-only`. Before any ticket wires
a real mutating tool into `deus-native`'s live surface, it MUST do one of:
(a) flip `deus-native`'s effective default to a restrictive profile, or
(b) add a construction-time guard that refuses to build the agent when a
non-`SAFE_TOOL_NAMES` tool is present under an omitted/allow-all profile.
Without one of these, a future caller could reasonably assume "the
authorization entrypoint exists, so it's enforcing" (per its billing in
`AGENTS.md`) while a mutation silently runs under `default`'s allow-all.

## Boundary with sandboxing and replay safety

This ADR documents an **application-level authorization layer** evaluated
inside the middleware stack. It does not claim, and should not be read to
imply, that this rule engine is a substitute for container, mount, or
credential isolation — `deus-v2-langchain-runtime.md`'s Decision 3 remains
the operative sandboxing boundary (`SAFE_TOOL_NAMES` web-only inclusion
filter; no OS-level sandboxing primitive exists in this repo for host-side
`deus-native` execution). This ADR does not widen `SAFE_TOOL_NAMES` and does
not claim authorization removes the need for that separate, future review.

This ADR also does not restate or modify `deus-v2-replay-safety.md`'s
claim-before/complete-after idempotency contract. That contract is triggered
by future mutation-tool wiring — the first time a mutating tool becomes
reachable from `deus-native`'s agent loop — not by permission-policy
evaluation itself. B7 adds no mutation tool and therefore needs no
speculative idempotency storage; a denied call is rejected before any
mutation attempt, and an allowed future mutation still separately needs the
replay ADR's claim/complete protocol once it is wired.

## Non-Goals

- No implementation of HITL approve/edit/interrupt flows, interactive
  permission prompts, or argument rewriting.
- No widening of `SAFE_TOOL_NAMES`; no host-side Bash, filesystem, browser
  automation, IPC mutation, scheduling mutation, group registration, git,
  Linear, or arbitrary MCP mutation tool.
- No replay-claim database/table or claim-before/complete-after wrapper —
  see Boundary section above.
- No replacement for container/mount/credential isolation, and no claim
  that application-level rules make unrestricted host tools safe.
- No plan-mode UI, command, prompt behavior, or automatic mode detection.
  This ADR supplies the named read-only primitive and the production
  selection seam; deciding when a turn is in plan mode is separate work.
- No argument-sensitive, path-sensitive, wildcard/regex, or
  user/group-specific rule matching.

## Amendment (2026-07-21): Interactive permission prompts for `deus chat` (follow-up ticket)

This amendment governs the new follow-up ticket described by
`LIA-466`. LIA-465
introduced the protocol types and proved the asynchronous permission round trip
without wiring it into a production runtime; this follow-up connects that
mechanism to `deus chat` and the production permissions middleware (`LIA-466`).
It does not retroactively make interactive prompts part of what
B7/LIA-407 itself delivered.

### Policy verdict rename and widening

The policy evaluator's type is renamed from:

```ts
PermissionDecision = 'allow' | 'deny'
```

to:

```ts
PolicyDecision = 'allow' | 'deny' | 'ask'
```

The rename resolves the collision with LIA-465's distinct transport-level
`PermissionDecision = 'allow_once' | 'allow_always' | 'deny'`
(`src/agent-runtimes/types.ts:117-122`;
`LIA-466`). The
following policy fields change from `PermissionDecision` to `PolicyDecision`
and therefore widen from two to three possible values:

- `PermissionRule.decision`
- `PermissionPolicy.defaultDecision`
- `PermissionEvaluation.decision`

These are the three fields presently defined against the policy evaluator's
two-value type (`src/agent-runtimes/permission-rules.ts:39-68`), and they are
the exact fields changed by this follow-up
(`LIA-466`).

`ask` is a deterministic policy verdict saying that execution requires an
external decision; it does not add mutable state, transport I/O, or prompting
to `evaluatePermission`. The evaluator remains a pure, exact-tool-name,
first-match-wins Chain of Responsibility with the policy's explicit
`defaultDecision` as its fallback
(`docs/decisions/deus-v2-permission-rules.md:69-82`,
`:180-195`). The asynchronous resolution happens afterward in the
`wrapToolCall` adapter. `ToolCallDecisionRecord.decision` remains
`'allow' | 'deny'`, because it records the resolved execution outcome rather
than the preceding policy verdict
(`LIA-466`;
`src/agent-runtimes/middleware-stack.ts:118-134`).

### Registry extension: `interactive`

`PERMISSION_PROFILES` gains an additive third named profile, `interactive`.
Under that profile, `web_search` and `web_fetch` evaluate to `ask`; the other
four catalogued read tools evaluate to `allow`; all eleven mutation-capable
tools evaluate to `deny`; and the profile's `defaultDecision` is `deny`
(`LIA-466`). References in the original ADR to the registry containing "exactly
two" profiles are therefore superseded by this amendment
(`docs/decisions/deus-v2-permission-rules.md:84-109`;
`src/agent-runtimes/permission-rules.ts:168-177`).

This is the extension mechanism already selected by the ADR's "Registry —
named policy lookup" design: a reviewed profile is added to
`PERMISSION_PROFILES` without changing `evaluatePermission`'s control flow
(`docs/decisions/deus-v2-permission-rules.md:190-195`;
`src/agent-runtimes/permission-rules.ts:168-177`). It does not alter rule
ordering, exact-name matching, first-match-wins precedence, or per-policy
fallback semantics.

### Narrowing the original interactive-prompt Non-Goal

For this follow-up, the original Non-Goals bullet:

> No implementation of HITL approve/edit/interrupt flows, interactive
> permission prompts, or argument rewriting.

(`docs/decisions/deus-v2-permission-rules.md:379-382`) is narrowed to mean:

> No LangChain-HITL-based approve/edit/interrupt or interactive
> permission-prompt flow using `interrupt()`/`Command`, and no argument
> rewriting.

The new prompt mechanism does not use LangChain's HITL machinery. LIA-465's
code comment records the governing distinction: its human-response
`PermissionDecision` intentionally has no `edit` variant, and the permission
path has no dependency on LangChain's unreliable upstream HITL edit mechanism
(`src/agent-runtimes/types.ts:117-121`). LIA-465's reconciliation further
records that it imports or instantiates neither LangChain `interrupt()` nor
HITL middleware, and instead resolves the terminal allow/deny outcome
asynchronously through a Deus-owned registry
(`scripts/spikes/lia465_protocol_boundary_permission_spike.md:41-52`).

The follow-up preserves that separation by promoting the independently owned
`PendingPermissionRegistry` — a `Map<requestId, { resolve, timeout }>` whose
timeout resolves to deny — and awaiting it only after the pure policy
evaluator returns `ask`
(`scripts/spikes/lia465_protocol_boundary_permission_spike.ts:43-78`;
`LIA-466`). Because
this mechanism neither calls LangChain `interrupt()`/`Command` nor offers an
`edit` outcome or reconstructs tool arguments, it does not fall under the
narrowed prohibition. LangChain-HITL-based prompting and all argument
rewriting remain out of scope.

### Mutating-tool precondition remains unchanged

The ADR's "Precondition for the first mutating-tool ticket" remains fully in
force and is not triggered or weakened by this amendment
(`docs/decisions/deus-v2-permission-rules.md:347-357`). This follow-up adds no
mutating tool and expressly makes no change to the production safe-tool
allowlist
(`LIA-466`). The live
boundary remains exactly:

```ts
DEUS_NATIVE_SAFE_TOOL_NAMES = ['web_search', 'web_fetch']
```

(`src/agent-runtimes/tool-broker-langchain-adapter.ts:133-144`). Any future
ticket that makes a mutating tool reachable must still satisfy the restrictive-
default/construction-guard precondition above and the separate replay-safety
contract; this interactive-prompt ticket supplies neither an exception nor a
substitute (`docs/decisions/deus-v2-permission-rules.md:359-377`).

### Continuing force of B7/LIA-407

This amendment belongs to the new interactive-permission follow-up ticket, not
to B7/LIA-407's original implementation. B7/LIA-407 remains otherwise
unchanged. Except for the expressly amended policy type/value set, named-profile
count, and interpretation of the interactive-prompt Non-Goal, its original
decisions, consequences, and reversibility/rollback provisions continue to
stand as written
(`docs/decisions/deus-v2-permission-rules.md:48-240`,
`:303-377`).

## Amendment (2026-07-22): Session-scoped `allow_always` persistence

This amendment governs the Track A follow-up scoped per
[LIA-470](https://linear.app/liams-private-workspace/issue/LIA-470/tui-session-scoped-allow-always-permission-grant-persistence).
The 2026-07-21 Amendment above shipped the live interactive prompt and its
three-way transport-level `PermissionDecision` (`'allow_once' | 'allow_always'
| 'deny'`), but the resulting production code deliberately left `allow_once`
and `allow_always` behaviorally identical, recorded in-line in
`src/agent-runtimes/middleware-stack.ts` at the time this amendment was
written:

> // 'allow_once' | 'allow_always' — this ticket treats both as "allow just
> this one call" (no persistence yet; see the plan's Non-goals).

This amendment closes exactly that named gap. It does not reopen or alter any
other decision in the 2026-07-21 Amendment or the original ADR.

### Behavioral change

`allow_once` and `allow_always` are now behaviorally distinct:

- `allow_once` continues to allow exactly the one live call and nothing more
  — unchanged.
- `allow_always` additionally records a session-scoped grant, in
  `SessionAlwaysAllowGrants` (`src/agent-runtimes/always-allow-grants.ts`),
  BEFORE delegating to the handler. A subsequent call in the SAME session for
  the SAME exact tool name short-circuits straight to the handler: no new
  `permission_request` event is emitted and no `PendingPermissionRegistry`
  entry is registered. The audit trail is not skipped — the short-circuit
  path still appends a `ToolCallDecisionRecord` with the new
  `source: 'always-allow-grant'` value before returning, so an
  auto-approved-by-prior-grant call remains distinguishable in the log from a
  freshly-asked-and-allowed one
  (`ToolCallDecisionRecord.source` widened from `'rule' | 'default'` to
  `'rule' | 'default' | 'always-allow-grant'`,
  `src/agent-runtimes/middleware-stack.ts`).

Matching is exact-tool-name only — no wildcard, prefix, or normalization
logic. The always-allow surface is bounded to whatever tools the
`'interactive'` profile already routes to `'ask'` (today: `web_search` and
`web_fetch` only, per the 2026-07-21 Amendment's `interactive` profile
definition), by construction, never wider.

### Store shape and lifecycle

`SessionAlwaysAllowGrants` wraps `Map<sessionId, Set<toolName>>` — keyed by
session, not a bare `Set` — because `buildPermissionsMiddleware()` is rebuilt
fresh every turn but the store itself is a process-wide singleton
instantiated once in `src/index.ts` (alongside `PendingPermissionRegistry`)
and threaded through `production-registry.ts` and `deus-native-backend.ts`
using the exact same optional-dependency wiring pattern
`PendingPermissionRegistry` already uses. A bare `Set` would leak grants
across sessions/groups sharing one daemon process.

The store is in-memory only, not SQLite-backed, and process-lifetime with no
automatic clearing in this pass:

- **In-memory, not restart-durable**: `PendingPermissionRegistry` — the one
  existing comparable security-state object — is itself in-memory and
  self-cleaning; nothing in this codebase requires restart-durability for a
  permission grant, and adding SQLite persistence would force an unasked-for
  policy decision about whether a resumed session should silently regain
  grants nobody re-consented to in that resumed session. This is a deliberate
  non-goal, not a silent gap.
- **No auto-clear**: unlike `PendingPermissionRegistry`, which self-cleans
  via a 120-second `setTimeout` per pending entry
  (`src/agent-runtimes/permission-registry.ts`), `SessionAlwaysAllowGrants`
  has no timer-based expiry. This is NOT justified by analogy to the
  registry's self-cleaning behavior — that analogy does not actually support
  "no cleanup" for a fundamentally different kind of state (a resolved grant,
  not a pending request). The real justification is independent and
  narrower: the always-allow surface is bounded to 2 tools today, so worst
  case is `O(sessions × 2)` entries on a personal, low-session-count daemon —
  genuinely small in practice, not "unbounded," but that is a distinct claim
  from the registry analogy and is stated as such here.
- A `clear(sessionId)` method ships now as a landing spot for a future revoke
  command; nothing in this pass wires it to any automatic session-close
  signal. `/v1/native-chat/close` has no session-scoped close signal to hook
  today — wiring one is separate, more invasive work, out of scope here.

### Non-goals (unchanged from the source plan)

- SQLite-persisted (restart-durable) `allow_always` grants — deliberately
  deferred.
- Mid-session grant revocation UI or automatic expiry — `clear(sessionId)`
  ships as an unwired landing spot only.
- Any change to rule evaluation, profile definitions, or the `'ask'` policy
  verdict itself — `permission-rules.ts` remains pure, with no mutable
  runtime state, per its own file-header contract. All always-allow logic
  lives in `middleware-stack.ts`'s `wrapToolCall`.

### Continuing force of the 2026-07-21 Amendment and B7/LIA-407

This amendment is additive only. The policy verdict rename/widening, the
`interactive` profile definition, the narrowed interactive-prompt Non-Goal,
the mutating-tool precondition, and every other provision of the 2026-07-21
Amendment and the original ADR continue to stand as written
(`docs/decisions/deus-v2-permission-rules.md:396-531`, `:48-240`,
`:303-377`).
