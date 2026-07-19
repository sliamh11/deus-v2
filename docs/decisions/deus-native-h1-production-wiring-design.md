---
name: LIA-454 — H1 production-wiring design (relocating wrapToolCall enforcement to the MCP seam)
description: >
  Design proposal for wiring LIA-449's CLI-subprocess + stdio-MCP transport
  into deus-native's production chat-turn path. Records an independently
  verified OAuth-policy finding and its resolution (user GO, see §0.1).
type: decision
tags: [deus-v2, agent-runtime, cli-subprocess, mcp, h1, lia-454, security, policy]
date: 2026-07-19
---

# LIA-454 — H1 Production-Wiring Design

**Status:** Design SHIP'd; §0/§3.1/§2.7 resolved. **Nested-dispatch (first
walking skeleton) implemented (2026-07-19)**, flag-gated behind
`DEUS_NATIVE_TRANSPORT=cli-subprocess` (default off) — see §4. Parent turn
loop still unchanged raw-HTTP; that's the next slice.
**Date:** 2026-07-19
**Scope:** `docs/decisions/` (this document is design/ADR only, touches no
production code). Eventual implementation would touch
`src/agent-runtimes/deus-native-backend.ts`, `src/agent-runtimes/nested-dispatch.ts`,
`src/agent-runtimes/nested-dispatch-tool.ts`, `src/agent-runtimes/model-selection.ts`,
`src/agent-runtimes/checkpointer.ts`, and would add a new Deus-owned MCP
tool server alongside `src/agent-runtimes/cli-subprocess/`.
**Author:** Autonomous overnight session, continuing
`Handoffs/2026-07-18-23-51-deus-v2-h1-wiring-and-scope-b.md`.
**Plan-review:** SHIP — native Claude (2 rounds: round 1 REVISE on an
unverified safety-parity claim and a wrong tool-catalog attribution, both
fixed and re-verified in round 2) + GPT co-gate SHIP. The §3.1 verification
spike this document called for has run and is CONFIRMED (see §3.1), and the
§2.7 checkpointing fork is RESOLVED (option A, see §2.7) — next step is the
real `/plan` implementation session.

## 0. NEW FINDING — this is a business/policy decision, not only an engineering one

Independent research this session (primary sources fetched directly, not
secondhand) confirms a risk the LIA-449 ADR itself flagged but could not
resolve (`docs/decisions/deus-native-cli-subprocess-mcp-seam.md:271-275`):
*"product/legal authorization for automated, subscription-backed CLI use in
any production path remains a wholly separate, unaddressed policy
question."*

**What was found:**

- Anthropic's own policy (`code.claude.com/docs/en/legal-and-compliance`,
  fetched directly): OAuth tokens issued to Free/Pro/Max/Team/Enterprise
  subscribers are restricted to **native Anthropic apps only**. Third-party
  developers must use metered API keys, not routed/automated subscription
  credentials. Server-side enforcement began **2026-01-09**; formalized in
  docs **2026-02-19** (these two dates could not be independently confirmed
  from the live docs page's own changelog/version history — flagged, not
  restated as unconditionally settled — but the surrounding policy language
  and the Roo Code timeline below are mutually consistent with them).
- **Roo Code** (a third-party Claude-Code-like tool) shipped a "Claude Code
  provider" that shelled out to the `claude` CLI as a subprocess to power
  its own agent loop — structurally the same pattern LIA-449/this design
  proposes. Confirmed first-party via `gh issue view`/`gh repo view` against
  `RooCodeInc/Roo-Code`: issue #10645, "Remove Claude Code provider
  (Anthropic compliance)," opened 2026-01-12 — three days after enforcement
  started — body text states "Anthropic has indicated they want third-party
  integrations... removed." The issue is `OPEN` (full removal not confirmed
  shipped); the repository itself is `isArchived: true`, last push
  2026-05-15.
- Full verification detail: `Research/2026-07-19-roo-code-anthropic-jan2026-policy-verification.md`
  (vault).

**Why this matters for this design, specifically:** LIA-449's transport
avoids the 429 by authenticating as the **native** `claude` CLI (the user's
own OAuth session) rather than a proxied raw-HTTP client. `h1-parity-signoff-lia433.md`
recorded that 429 as "on the very first call," both 2026-07-14 and
2026-07-18 — consistent with a structural block, not a load-dependent rate
limit. Taken together, the working hypothesis this design should carry
forward is: **the raw-HTTP path's 429 may be Anthropic's OAuth-restriction
enforcement, not merely congestion** — and the CLI-subprocess transport
"succeeding" is not necessarily "found a technical workaround," it may be
"used the one channel the policy still permits, in a way (automated,
production, subscription-backed) the policy's own intent may not cover
either." Roo Code's situation is the closest real-world precedent for
exactly this shape of usage, and Anthropic's ask there was **remove it**,
not "keep it, just disclose it."

**This is why implementation does not follow this design doc even though
plan-review SHIPped it.** Engineering soundness and policy/ToS authorization
are separate gates. The former is this document's job — done. The latter is
the user's call — it touches account standing, product legal exposure, and
a business decision about whether Deus should depend on automating a
consumer-subscription CLI in a production path at all (vs., e.g., budgeting
for metered API-key usage instead, which is unambiguously policy-compliant
and sidesteps this entire question). **At the time this was written, the
recommendation was: do not implement any part of §3 below until the user
has explicitly reviewed §0 and decided how to proceed** — the options laid
out were (a) proceed anyway with an explicit risk-acceptance decision, (b)
implement but keep it behind a flag never enabled in real production
traffic pending Anthropic clarification, (c) pursue metered API keys
instead and abandon the CLI-subprocess direction for production (LIA-449's
spike/research value stands regardless), (d) ask Anthropic directly. **This
has since been superseded — see §0.1: the user chose (a)/(effectively the
Zed/VS Code-precedent variant of proceeding), and implementation is now
authorized.**

Everything below is the engineering design, produced so that whichever way
this policy question resolves, the implementation work is not starting from
zero.

### 0.1 Resolution — user GO decision (2026-07-19)

The user was given the actual tradeoff directly (Anthropic's
OAuth-restriction text, the Roo Code precedent and how LIA-449's mechanism
differs from it, the genuine residual ambiguity in "on behalf of their
users" framing, and the real personal-account risk), conditioned on
confirming this mechanism matches how official IDE tooling does it. That
confirmation was independently verified, not just asserted: Zed's Claude
Code integration wraps the official `@anthropic-ai/claude-agent-sdk` via ACP
(`zed.dev/blog/claude-code-via-acp`), and — stronger corroboration since
it's first-party, not third-party — Anthropic's own VS Code extension
"bundles the same `claude` CLI underneath... same authentication"
(`code.claude.com/docs/en/vs-code`). Both ultimately spawn the real,
unmodified `claude` binary via stream-json, the same mechanism LIA-449
built (confirmed via a 2026-07-18 static read of the SDK's compiled source:
it does nothing more than spawn+stream-json, no special headers/attestation).
Roo Code's blocked mechanism, by contrast, extracted the raw OAuth token for
its own HTTP client — the same shape as `deus-native`'s old, already-blocked
`buildProxyRoutedChatAnthropic`, materially different from LIA-449's
real-subprocess approach.

The user's response: *"If that's how Zed works as well - I'm good with that
approach. lets go with that."*

This clears this document's §0 policy gate. Recorded as a Linear comment
thread on LIA-454 (`comment-492fb737`, 2026-07-19T02:49:23Z) rather than by
editing this document directly at the time, to avoid a git conflict with
the concurrent session that owned this worktree — reconciled into this
document now. Full verification trail:
`Session-Logs/2026-07-19/deus-v2-lia454-policy-goahead.md` (vault).

Implementation is now authorized to proceed. §3.1's core safety mechanism
(does an MCP tool-error response reach the CLI's model loop equivalently to
`wrapToolCall`'s `ToolMessage` substitution) has since been verified by a
dedicated spike — see §3.1's own "CONFIRMED" update and
`scripts/spikes/lia449b_mcp_deny_equivalence_spike.md`. The §2.7
checkpointing fork is also resolved (option A — see §2.7). The real
`/plan` implementation session (forward-brief item 3) is the next step.

## 1. Why this ticket exists

Recap, already recorded in Linear (LIA-454) and `Handoffs/2026-07-18-23-51-*.md`:
LIA-449 (merged, PR #42) proved the CLI-subprocess + stdio-MCP transport
avoids H1/LIA-433's persistent 429 in a real credentialed smoke test (17/17
assertions PASS). LIA-452 (Scope B) independently confirmed the same 429
through the actual production `deus-native` chat path — `deus-v2 chat` is
not usable for real conversations until this transport is wired into
production. Wiring it in is not a model-client swap: `deus-native-backend.ts`
delegates its entire turn-execution loop to LangChain's `createAgent`/
`agent.invoke()`, while the CLI subprocess owns and executes its own agent
loop internally. Deus's real security enforcement (`middleware-stack.ts`'s
`wrapToolCall` chain) only fires inside that LangChain loop today.

## 2. Controlling facts (this session's research, file:line cited)

### 2.1 Today's turn-execution loop (`deus-native-backend.ts`)

`runTurn()` (`deus-native-backend.ts:267-764`) builds a model client, a tool
list, a middleware array, and a checkpointer, then:

```
deus-native-backend.ts:593-601
const agent = createAgent({
  model, tools, middleware: allMiddleware,
  checkpointer: getCheckpointer(),
});

deus-native-backend.ts:613-623
const result = await agent.invoke(
  { messages: [new HumanMessage({ id: currentTurnMessageId, content: runContext.prompt })] },
  { configurable: { thread_id: outgoingSessionId } },
);
```

Only two call sites construct/invoke a LangChain agent anywhere in
`src/agent-runtimes/`: this one (parent, with checkpointer) and
`nested-dispatch.ts:320-335` (child, no checkpointer, one-shot). This bounds
the redesign's blast radius to exactly these two.

### 2.2 Model/tier selection is trivially portable

`buildProxyRoutedChatAnthropic(runContext, modelId)` (`deus-native-model.ts:49-89`)
constructs one `ChatAnthropic` per call; **the only field that varies
between "tiers" is the `modelId` string** — no per-tier temperature,
max_tokens, or other generation parameter exists anywhere in this path
(confirmed via the function's own doc comment, `deus-native-model.ts:42-47`).
Tier resolution itself is a one-line lookup: `resolveEffectiveRoleModel`
(`model-selection.ts:155-160`) does an exact-match lookup of `role` in
`config.roles`, falling back to `config.main`. **Implication for the new
design:** mapping a tier onto the CLI transport is just "which `--model`
flag to pass to that conversation's `claude` invocation" — no other
per-tier plumbing exists to replicate.

### 2.3 The CLI-subprocess pool already exposes everything needed — except pre-execution interception

`ClaudeCliSessionPool.sendTurn()` (`claude-cli-session-pool.ts:568-599`)
returns a `TurnResult` (`:339-347`) that includes **both** the terminal
result **and** the full mid-turn event stream (`events: StreamJsonEvent[]`),
confirmed exercised by LIA-449's own smoke test filtering `isAssistantEvent`/
`isUserEvent` to inspect a specific tool call's args and result
(`lia449_cli_subprocess_mcp_walking_skeleton.ts:381-426`). This was more
visibility than the LIA-454 ticket's own framing assumed ("the pool's
public API just doesn't expose them yet" — not true; it does).

**But this doesn't rescue an observation-based design.** Confirmed directly:
the `claude` CLI subprocess decides and executes each tool call against
Deus's own MCP server over its own stdio connection; the pool's NDJSON
parser (`handleStdoutChunk`/`handleParsedLine`, `claude-cli-session-pool.ts:638-708`)
only reads the CLI's **after-the-fact record** of a round-trip that already
finished. The pool has no code path that intercepts, permits, or executes
a call — it is a pure observer. **This confirms the ticket's own framing is
correct: the gate must run inside the MCP tool handler itself (before the
handler performs the real action), not anywhere in the pool.**

### 2.4 What actually needs relocating — narrower than "the whole middleware stack"

`CANONICAL_MIDDLEWARE_ORDER` (`middleware-stack.ts:86-91`) is
`['permissions', 'wardens', 'memory', 'telemetry']`. Classified by whether
each mechanism structurally requires pre-execution blocking inside
`wrapToolCall` (research detail: `middleware-enforcement` report, §4 table):

| Mechanism | Must relocate onto the MCP seam as a pre-execution gate? |
|---|---|
| **permissions** (`middleware-stack.ts:256-278`) | **Yes.** Per-call decision (`evaluatePermission(policy, toolName)`), must block before the real action runs. This is the one mechanism that is live and load-bearing on deus-native's actual production tool surface today. |
| **wardens** (`middleware-stack.ts:618-660`) | **Yes, for parity/future-proofing — but currently dormant.** `apply_patch`/commit-shaped `Bash` are never registered on `SAFE_TOOL_NAMES` (`middleware-stack.ts:46-48`), so this layer does not fire on any tool deus-native's production chat surface exposes today. It must still be designed in (as a second gate check inside the same handler wrapper), because the moment a gated tool is ever added to the production surface, parity would silently regress otherwise. |
| **memory retrieval** (`beforeModel`) | No — fail-open, once-per-turn, additive-only. Runs fine as a pre-turn context-assembly step outside the tool-execution boundary (e.g., prepended to the CLI's initial prompt for that turn). |
| **memory re-embed** (`wrapToolCall`, post-hoc) | No — already runs strictly after a successful tool result. Can become a post-turn hook reading the CLI's own retained events instead. |
| **telemetry** (`wrapModelCall`) | No — pure observation, never blocks. Derivable from the CLI's own usage/result event instead. |
| **context compaction** (`beforeModel`) | Not a tool-execution concern — a model-input-shaping step. The CLI subprocess does not take a LangChain message array as input in the first place (it owns its own context via its own session), so this specific mechanism (truncate-and-summarize a LangChain message list) does not port over as-is — see §3.4. |

**Conclusion: the actual "must relocate to run before execution" set is
small — permissions today, wardens for future parity.** This is
significantly narrower than "port the whole middleware stack," which
lowers both the implementation size and the security-review surface of the
change described in §0.

### 2.5 Nested dispatch already has the right shape for a subprocess-per-dispatch redesign

`nested-dispatch.ts:320-335` constructs a fresh, one-shot `createAgent()`
per dispatch, **with no checkpointer** — "children are one-shot and create
no persistent session state" (`nested-dispatch.ts:242-243`), and the child
never sees the parent's transcript (`nested-dispatch.ts:56-58`, only the
explicit task prompt). This is already exactly the lifecycle shape a fresh
`pool.createConversation()` + one `pool.sendTurn()` + `pool.shutdownAll()`
(or a short idle-timeout reap) would need — no persistent state to migrate,
no checkpointer semantics to preserve. **Nested dispatch is the easier of
the two call sites to port**, and could reasonably be built/proven first as
an even smaller walking skeleton before touching the parent turn loop's
checkpointed continuity.

### 2.6 Transcript storage needs no interface change

`appendDeusNativeTranscriptTurn`'s input contract (`transcript-store.ts:23-36`)
is entirely primitive types (strings, `Date`s, and two small typed arrays) —
no LangChain `BaseMessage`/`AIMessage` type appears anywhere in the
function signature. A caller that reduces the CLI pool's `TurnResult`
(`assistant`/`tool_use`/`tool_result` events + the terminal `result`) into
the same `TranscriptTurnInput` shape can call this function unchanged.
**No storage-layer redesign needed** — only a small adapter that maps
`StreamJsonEvent[]` → `TranscriptToolCall[]`/`TranscriptUsageEvent[]`.

### 2.7 Checkpointing — RESOLVED (2026-07-19): option (A)

**Decision: (A), keep LangGraph checkpointing and wrap the CLI's result
back into it.** The user chose this directly, given the (A) vs (B)
tradeoff below, after the §3.1 spike confirmed the deny-parity mechanism.
Rationale: this design is explicitly a strangler-pattern migration (§3.6,
flag defaults off) — preserving 100% of existing checkpoint-consuming code
(context compaction) exactly as-is, with zero behavioral gap during the
strangler period, outweighs the added translation-layer cost. Option (B)'s
"breaks context compaction, needs its own CLI-native equivalent or an
accepted gap" was judged too risky to accept for a real production path,
even temporarily. The real implementation plan (forward-brief item 3)
should build the CLI-result → LangChain-message → `SqliteSaver.put`
translation adapter as part of its walking skeleton, and re-verify
compaction triggers correctly against CLI-turn-derived checkpoint rows
(the re-verification burden (A) itself flags below) before treating it as
settled.

`getCheckpointer()` (`checkpointer.ts:62-69`) returns a `SqliteSaver`
(`@langchain/langgraph-checkpoint-sqlite`), a `BaseCheckpointSaver` — a
LangGraph graph-state persistence abstraction, consumed generically by
`createAgent({checkpointer})`'s own internal graph execution. If the CLI
subprocess replaces LangGraph's graph entirely for a given turn, this
checkpointer's `.put`/`.get` calls (invoked internally by LangGraph, not by
Deus's own code — confirmed: `checkpointer.ts` itself contains no explicit
`.put`/`.get` call) would not fire for CLI-subprocess-routed turns.

Two real options were weighed — (A) was chosen, per the resolution above:

- **(A) — CHOSEN. Keep LangGraph checkpointing, wrap the CLI's result back into it.**
  After each CLI turn, synthesize the equivalent LangChain messages from
  the CLI's `TurnResult` and write them through the existing checkpointer
  API, preserving `B4`'s conversation-continuity contract exactly.
  Preserves 100% of existing checkpoint-consuming code (context compaction,
  any future code that reads checkpoint history) but adds a translation
  layer and a re-verification burden ("does compaction still trigger
  correctly against CLI-turn-derived checkpoint rows?").
- **(B) — NOT CHOSEN. Use the CLI's own native session continuity** (the
  `claude` CLI already supports resuming a conversation by session id) as
  the source of truth for continuity, keeping a lightweight Deus-owned
  mapping (`thread_id` → CLI conversation id) instead of routing through
  `SqliteSaver`. Simpler, avoids a translation layer, but breaks context
  compaction as currently implemented — rejected because that gap was
  judged too risky for a real production path (see resolution above).

## 3. Proposed design

*(Design accepted per §0.1's GO decision — not yet implemented. §3.1's core
safety mechanism has since been verified by spike (see §3.1's "CONFIRMED"
update) and the §2.7 checkpointing fork is resolved (option A). The real
`/plan` implementation session is the next step.)*

### 3.1 Tool catalog: a Deus-owned MCP server mirroring `SAFE_TOOL_NAMES`

Extend `permission-check-mcp-server.ts`'s pattern into a real production MCP
server exposing the same tool catalog deus-native's production tool surface
uses today: `web_search`/`web_fetch` from `buildSafeTools()`
(`tool-broker-langchain-adapter.ts:140-142,269-279` — `SAFE_TOOL_NAMES` is
exactly `{web_search, web_fetch}`), plus `dispatch_nested_agent`, which is
wired separately at the `runTurn` call site
(`deus-native-backend.ts:569-570`), not part of `buildSafeTools()`'s own
output — dispatch is designed separately in §3.3 via the pool mechanism,
not through this MCP tool catalog. Each tool handler:

1. Calls `evaluatePermission(policy, toolName)` — the exact same pure
   function `middleware-stack.ts:258` calls today — **before** performing
   the real action. On deny, return an MCP tool error whose text mirrors
   today's synthetic `ToolMessage` content (`middleware-stack.ts:269-277`).
2. If the tool is one of the (currently zero, but designed-in) warden-gated
   ones, run `selectWardenBehaviors`/`runWardenBehavior`
   (`middleware-stack.ts:318-332`, `:474-549`) the same way, before the
   real action, fail-closed on error exactly as today
   (`middleware-stack.ts:556-561`).
3. Only then perform the real action and return its result.

**CONFIRMED (2026-07-19)** — step 1's "the model sees an equivalent denial
message either way" was unverified when this document was first written
(the one existing precedent, `permission-check-mcp-server.ts`'s
`check_permission` tool, `handleCheckPermission`:63-78, is a read-only
probe that never exercises a real MCP `isError`/deny path). The required
spike has now run: `scripts/spikes/lia449b_mcp_deny_equivalence_spike.md`
(+ `.ts`, + two independent live-run `.results.json` captures, both
2026-07-19). Both controlling facts hold — the CLI subprocess's own
`tool_result` event carries `is_error: true` for a denied call (the raw
wire-protocol fact), and the model's own final response demonstrates it
understood the call was blocked and did not fabricate success (the
behavioral fact) — across two independent live runs, zero rate-limit
evidence, no retry loop on the denied call. **§3.1's mechanism is
functionally equivalent to `wrapToolCall` substituting a `ToolMessage`
today and may now be treated as the stated production mechanism for
relocating the `permissions` enforcement layer.** One implementation detail
the spike surfaced: the CLI represents a denied tool result's `content` as
a plain string, not the array-of-parts shape a normal result uses — any
code reducing CLI tool-result events (e.g. §2.6's transcript-mapping
adapter) must handle both shapes; this is now fixed and regression-tested
in the shared `stream-json-protocol.ts` helper the spike also uses.

### 3.2 Model tier selection

Resolve `resolveEffectiveRoleModel()` the same way as today, then pass the
resolved model id as the `--model` flag (or equivalent CLI arg — needs
confirming against the CLI's actual flag surface, not yet verified this
session) when calling `pool.createConversation()`/spawning that
conversation's process.

### 3.3 Nested dispatch (recommended first walking skeleton)

Per §2.5: a dispatch call becomes `pool.createConversation()` +
`pool.sendTurn(childConversationId, request.prompt)` + a short idle-timeout
or explicit `pool.terminateSession()` after the result returns — no
checkpointer involved, matching today's no-persistent-state child
semantics exactly. Recommended as the smaller, lower-risk first production
wiring step, isolated from the parent loop's checkpointing fork (§2.7).

### 3.4 Parent turn loop, context, and compaction

Per §2.7's resolution (option A): the existing `beforeModel`
memory-retrieval and context-compaction mechanisms keep working against
the synthesized checkpoint rows with no redesign — this document's own
design for both stands unchanged. The real implementation plan must still
re-verify compaction actually triggers correctly against CLI-turn-derived
checkpoint rows (the re-verification burden §2.7 flags), not just assume
it from this design.

### 3.5 Process lifecycle / orphan control (production-readiness gap, currently unaddressed)

Per §2 of the `cli-pool` research: idle-timeout reaping, in-process
concurrency capping, and cooperative graceful/escalating termination all
exist today in `ClaudeCliSessionPool`. **Startup-time orphan reconciliation
for non-cooperative parent death (crash, SIGKILL, power loss) and
cross-process/production-wide concurrency control do not exist anywhere in
this module** — an explicit, stated gap in the LIA-449 ADR itself
(`deus-native-cli-subprocess-mcp-seam.md:261-264, 285-286`), not something
this session's research found evidence was silently solved elsewhere.
**This must be built before any production rollout**, regardless of the
policy question in §0 — an unbounded-orphan-process failure mode is a cost/
reliability risk independent of ToS status. Proposed shape (not yet
designed in detail): a startup-time scan for `claude` processes tagged with
a Deus-owned marker env var, killed if their parent Deus process is gone; a
filesystem-lock-based cross-process concurrency cap in `STORE_DIR`, since
the in-process cap alone doesn't bound multiple Deus process instances.

### 3.6 Rollout posture

Strangler pattern, matching LIA-449's own "build beside, not inside"
posture (`deus-native-cli-subprocess-mcp-seam.md:218-221`): a flag
(e.g. `DEUS_NATIVE_TRANSPORT=cli-subprocess`, default unset/`raw-http`)
selects which path `runTurn`/`nested-dispatch` use, defaulting to the
existing, unchanged, byte-for-byte raw-HTTP path. **Given §0, this flag
should default OFF in every environment, including any the user
personally runs, until the policy question is explicitly resolved** — not
merely off-by-default-in-code while quietly turned on for testing, since
"testing" is itself the kind of automated CLI use the policy question is
about.

## 4. LIA-454 acceptance-criteria disposition

| AC | Disposition |
|---|---|
| A real design doc/ADR addressing the relocation-of-enforcement question, plan-reviewed with full rigor, before any implementation | **This document** — plan-review SHIP (native Claude, 2 rounds; GPT co-gate SHIP). §0's policy flag was a new, load-bearing input for the user before implementation — **resolved via user GO, see §0.1.** |
| Production `deus-native` chat turns route through the new transport (behind a flag, strangler pattern) without regressing `wrapToolCall`'s enforcement coverage | **Implemented (2026-07-19, EP-002 steps 9-12)**: `DEUS_NATIVE_TRANSPORT=cli-subprocess` (still default off) now selects the COMPLETE parent-and-nested CLI strategy, not just nested-dispatch children. `runTurn()` branches immediately before the raw-HTTP path's own checkpoint read; the CLI branch routes through `parent-turn-runner.ts` → a new `parent-turn-mcp-server.ts` exposing the parent's full 3-tool catalog (web_search/web_fetch/dispatch_nested_agent), with permissions/wardens relocated onto the MCP tool-handler boundary via a shared `mcp-tool-gate.ts` (extending, not duplicating, the nested-dispatch pattern below). A real, severe bug in the initial parent-loop wiring (prior checkpoint history was read but never actually sent to the CLI — memoryless past turn 1) was caught and fixed via a history file delivered through `--append-system-prompt-file`, with the codebase's established untrusted-content-framing convention applied to every historical tool-result before it enters that file at system-prompt authority (this convention was itself hardened at final gate review — see below). Independently verified by a real credentialed smoke test (`scripts/spikes/lia454_parent_turn_cli_subprocess_smoke.ts`): real cross-turn recall (turn 2 correctly recalls a fact stated only in turn 1 — the actual oracle for the history fix), real end-to-end nested dispatch, a real read-only permission-profile denial reaching the model without fabricated success, and independent checkpoint-durability re-read — zero 429s across the whole run. (The nested-dispatch-only wiring below remains accurate for the PR #47 slice that shipped first, prior to the parent loop landing.) Nested-dispatch children route through the CLI-subprocess transport when `DEUS_NATIVE_TRANSPORT=cli-subprocess` — new `nested-dispatch-mcp-server.ts` relocates the `permissions` pre-execution gate onto the MCP seam per §3.1's confirmed mechanism, receiving the SAME per-turn `rawPermissionProfile`/`wardenCwd`/`ToolBrokerContext` values the parent's own middleware uses (marshalled via a new `DEUS_NESTED_DISPATCH_CONTEXT` env channel — see `CliSubprocessNestedDispatcherDeps.mcpServerContext` in `cli-subprocess-nested-dispatcher.ts`), fails closed on missing/malformed context, and structurally checks `selectWardenBehaviors` (dormant today, same as the parent). Independently verified by a real credentialed smoke test (`scripts/spikes/lia454_nested_dispatch_cli_subprocess_smoke.ts`): no 429 in either an allow or a deny case, the deny case fails closed with the model correctly reporting the denial (never fabricating success), and the spawned subprocess is reaped after each dispatch. **Real, named, deliberately deferred gaps (not silent)**, each a filed Linear ticket: context-compaction integration for the CLI path (LIA-457 — long conversations hard-fail once they exceed the context window rather than compacting, until this lands); control-group memory-recall integration for the CLI path (LIA-458); the raw-HTTP path's own pre-existing, unfixed same-thread checkpoint-concurrency gap, which the new cross-process lease deliberately does NOT retrofit onto already-live code as a side effect of this migration (LIA-459); nested-dispatch child usage from inside the parent MCP subprocess not yet folded into `RunResult.usage` on this transport (LIA-460). **Final gate review (EP-002 step 13, 3 Opus passes — code-reviewer/ai-eng-warden/verification-gate, all SHIP)** caught one real, fixed security gap: the untrusted-content-framing helper escaped tag attributes but never body content — acceptable at the two original lower-stakes tool-role call sites, but a genuine gap once reused to wrap content promoted to system-prompt authority (a fetched page literally containing the closing-tag text could otherwise break the boundary); fixed via `neutralizeKnownClosingTags` in `parent-turn-history.ts`, verified by 4 new tests including that a legitimate pre-existing inner boundary (`<tool-output>`) is left untouched. |
| A7 tool-loop-reliability benchmark re-run against the new transport | Not attempted — per the design's own ordering (forward-brief item 5) and EP-002's own Goal section, this is explicitly scoped as a separate follow-up ticket, not part of EP-002's own done-criteria. The parent-loop wiring this benchmark needs as its target now exists (EP-002 steps 9-12), so this AC is unblocked and ready to be picked up as that separate ticket — it was deliberately not folded into this already-large migration. |
| Production-grade process-lifecycle management (280-process/65GB/$183-day precedent avoided) | **Implemented (2026-07-19, EP-002 step 9)**: the full cross-process registry now exists in `process-lifecycle-registry.ts` — a `thread_id`-keyed exclusive turn lease (closing a real lost-update race SQLite's own serialization does not close) and a fixed-size production-wide CLI-process-slot cap, both using atomic `O_CREAT|O_EXCL`/rename-based file locking with PID + process-start-identity verification to distinguish a live owner from a PID-reuse impersonator. Went through 2 rounds of code review that caught and fixed a real double-grant TOCTOU in the original unlink-then-recreate eviction design; one narrow residual restore-window race remains, explicitly documented and accepted (requires the underlying staleness signal to flip within a single attempt — expected rare, not theoretical) rather than closed via full OS advisory locking, which was assessed as disproportionate for this migration's actual production exposure (still default off). The "280-process" figure itself was never independently verified against the original LIA-449 ADR — likely sourced from the LIA-454 Linear ticket's own context. The registry is a lease/cap mechanism, not startup-time orphan-process reconciliation for a non-cooperative parent crash — that narrower scan-and-kill mechanism described in §3.5's original proposal remains unimplemented; the lease/cap design was judged to close the more load-bearing correctness gap (cross-process checkpoint races) at proportionate effort for this migration's scope. |
| Cross-platform story stated explicitly | **Not addressed.** `ClaudeCliSessionPool` is POSIX-only by deliberate design (`deus-native-cli-subprocess-mcp-seam.md`, §6, "Platform scope") — Windows support does not exist in the underlying transport this design builds on. This is an open gap this document surfaces but does not resolve. |

## 5. What this document explicitly does NOT do

- **Did not, by itself, authorize implementation** — §0 flagged that as a
  separate, explicit user decision on the policy question, independent of
  this design's engineering merit. **That decision is now recorded (§0.1,
  GO)**; implementation may proceed, starting with the §3.1 spike below.
- **The checkpointing fork (§2.7) is now resolved** — option A, chosen
  directly by the user on 2026-07-19. See §2.7's resolution note.
- **§3.1's MCP-error-denial-parity mechanism is now verified** by
  `scripts/spikes/lia449b_mcp_deny_equivalence_spike.md` (two independent
  live runs, both PASS) — see §3.1's "CONFIRMED" update. This was the
  concrete pre-implementation spike this document originally required.
- **Does not verify the "280-process/65GB/$183-day" figure** cited in the
  LIA-454 ticket description — not found in any file read this session;
  flagged as an unverified secondhand figure, not restated as settled fact.
- **Does not change `backend-neutral-agent-runtime.md`'s parity matrix**,
  `claude`'s status as the default backend, or H2/LIA-434's blocked status.
  Those remain exactly as recorded in `h1-parity-signoff-lia433.md`.

## References

- `Handoffs/2026-07-18-23-51-deus-v2-h1-wiring-and-scope-b.md` (vault, this
  session's starting point)
- `scripts/spikes/lia449b_mcp_deny_equivalence_spike.md` (§3.1's
  verification spike, CONFIRMED, 2026-07-19)
- `docs/decisions/deus-native-cli-subprocess-mcp-seam.md` (LIA-449 ADR)
- `docs/decisions/h1-parity-signoff-lia433.md` (H1 NO-GO record, 429
  evidence)
- `docs/decisions/deus-v2-langchain-runtime.md` (review-rigor precedent)
- `Research/2026-07-19-roo-code-anthropic-jan2026-policy-verification.md`
  (vault, this session's independent policy verification)
- Linear: LIA-454 (this ticket), LIA-449 (done), LIA-452 (found the
  production dependency), LIA-433 (H1 NO-GO), LIA-434/LIA-436 (blocked on a
  future H1 GO)
