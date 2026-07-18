# ADR: Hook dispatch is Claude-Code-coupled — the model-agnostic ADRs are an unbuilt facade

**Status:** Accepted (correction)
**Date:** 2026-06-07
**Scope:** Corrects the status of `hook-dispatch-system.md` and clarifies `ADR-001-hook-dispatch-service.md`. No code change — this ADR records a discovered gap between Accepted design and shipped reality.
**Corrects:** [hook-dispatch-system.md](hook-dispatch-system.md) (→ *Accepted but Not Implemented*), [ADR-001-hook-dispatch-service.md](ADR-001-hook-dispatch-service.md) (clarified scope)
**Relates to:** [backend-neutral-agent-runtime.md](backend-neutral-agent-runtime.md), [facade-prevention-mechanism.md](facade-prevention-mechanism.md), [tui-permission-bridge.md](tui-permission-bridge.md)
**Deciders:** Deus Engineering

---

## Context

The "Odysseus as Deus's native GUI" investigation (2026-06-07) asked a sharp
question: *if Odysseus owns the chat UI, do Deus's hooks/wardens still fire?*
Answering it required tracing whether the hook system is actually
backend-neutral, as two **Accepted** ADRs claim:

- `hook-dispatch-system.md` (Accepted 2026-05-14) — "Model-Agnostic Hook
  Dispatch System." Specifies a host-side **Enforcement Layer** that "fires in
  `message-orchestrator.ts` before/after container execution," a `HookPipeline`
  interface (`enforce()` / `observe()`) as part of the `AgentRuntime` contract,
  a Bridge-pattern adapter per backend, and a plan to make "14 of 15 hooks …
  host-enforced (model-agnostic)."
- `ADR-001-hook-dispatch-service.md` (Accepted 2026-05-23) — a `:3002`
  `HookDispatchService` with a blocking `PreToolUse` hook.

Both are marked **Accepted** with no implementation-status caveat. A reader
(human or agent) would reasonably assume the model-agnostic hook pipeline
exists. **It does not.** This ADR records that finding so the decision log
stops asserting an architecture that was designed but never built.

## Evidence (two independent methods agree)

**Method 1 — primary-source code trace** (deep-research report, vault:
`Research/2026-06-07-odysseus-as-deus-gui-and-hook-coupling.md`).

**Method 2 — direct grep over `src/`** (commit `0c597060`, 2026-06-07):

| Claim in `hook-dispatch-system.md` | Reality |
|---|---|
| `HookPipeline` interface in the `AgentRuntime` contract | `grep -rn "HookPipeline" src/` → **NONE** |
| `enforce()` / `observe()` methods | `grep -rn "\.enforce(\|\.observe("` → **NONE** |
| Enforcement Layer "fires in `message-orchestrator.ts`" | `message-orchestrator.ts` → **zero** hook / warden / enforce / SessionStart / UserPromptSubmit refs |
| Per-backend adapters fire hooks | `openai-backend.ts`, `container-backend.ts` → **zero** hook refs |

What *does* exist:

- `.claude/settings.json` registers every gate (SessionStart, UserPromptSubmit,
  PreToolUse ×7, PostToolUse ×2). These fire **only because the Claude Code CLI
  executes them.**
- `.claude/hooks/warden-shim.sh` → `python3 scripts/codex_warden_hooks.py run <gate>`.
- `scripts/codex_warden_hooks.py` — the gate *logic*, which **is** backend-neutral.
- `HookDispatchService` (`:3002`) — real, but **container-only**
  (`container/agent-runner/`), **`HOOK_DISPATCH_ENABLED` default false**,
  **observer-only**, and still **triggered by Claude Code's own hook scripts**.

## Decision

1. **Re-status `hook-dispatch-system.md` as "Accepted but Not Implemented
   (facade)."** Its design is sound and remains the reference design for a
   future build; its Status no longer implies shipped code. A banner at the top
   of that file points here.

2. **Clarify `ADR-001-hook-dispatch-service.md`.** The `:3002` service it
   describes is real but narrower than a reader assumes: container-only,
   default-off, observer-only, Claude-Code-triggered. A banner notes the scope
   and the contradiction below.

3. **Record the load-bearing truth.** Enforcement is **logic-decoupled but
   trigger-coupled**: the gate logic (`codex_warden_hooks.py`) is backend-neutral,
   but the only thing that *invokes* it is Claude Code's hook engine reading
   `.claude/settings.json`. **No Claude Code ⇒ no hooks, no wardens, no memory
   injection, no persona.** A non-Claude backend (OpenAI/Codex/Ollama) today
   runs unguarded.

4. **Record the internal contradiction between the two prior ADRs — and which
   side the shipped code chose.** `ADR-001` says `PreToolUse` *blocks*
   (`{ decision: "block" }` forwarded to the SDK); `hook-dispatch-system.md`
   says the Observer Layer `PreToolUse` "can return `updatedInput` but **NOT**
   `deny`." Both cannot be the contract. The shipped container hook
   `container/agent-runner/src/pre-tool-use-hook.ts` (L54–63) **does forward
   `decision: "block"`** to the SDK — so the implementation followed
   **ADR-001 (blocking)**, and `hook-dispatch-system.md`'s "Observer Layer
   cannot deny" axiom was **already breached by shipped code** (the code even
   labels the blocking path "Blocked by PreToolUse *observer*"). A future
   implementer of the host-side `HookPipeline` must **not** carry the
   observer-only axiom forward as a clean constraint — the container
   `PreToolUse` already blocks in practice.

5. **Do not build remediation in this change.** The user explicitly chose
   document-first over building. Remediation options are recorded for a future,
   separately-approved decision (see below).

## Why facade-prevention did not catch this

`facade-prevention-mechanism.md` targets *built-but-not-wired* code — symbols
with green unit tests but no live caller (the LIA-133 class). This is a
**different class**: an Accepted ADR with **no implementation at all**. There is
no symbol to flag, no zero-caller edge to detect — the gap lives entirely in the
decision log, not the code graph. The existing three layers (connectivity
warden, flag-lint CI, orphan-sweep) are all code-anchored and structurally
cannot see "Accepted ADR, never coded." Worth a future extension: an ADR-status
audit that cross-checks each Accepted ADR's claimed `Scope:` paths against the
code that should exist there.

## Consequences

### Positive
- The decision log stops asserting a model-agnostic hook pipeline that doesn't exist.
- Future work (Odysseus-as-GUI, non-Claude backends) starts from ground truth, not the facade.
- The "logic-decoupled / trigger-coupled" framing is now written down once.
- A future HookPipeline implementer inherits the corrected `PreToolUse` contract (blocking already shipped), not the breached observer-only axiom.

### Negative / accepted
- Until a HookPipeline is built, **non-Claude backends have no guardrails.** This
  is a known, documented limitation — not a silent one. **Partially superseded
  for `deus-native` as of C1/LIA-409 — see "Update (F2/LIA-424 — 2026-07-16)"
  below — but the enforcement trigger remains DORMANT in production per the
  same ADR's "Update (C5/LIA-413 — 2026-07-17)": `SAFE_TOOL_NAMES`
  (`tool-broker-langchain-adapter.ts:131`) excludes `apply_patch`/`Bash`, so
  no protected call currently reaches the wardens gate on the live
  deus-native tool surface.** This statement remains fully accurate,
  undiminished, for the container Claude SDK, OpenAI, and llama-cpp paths.
- The two prior ADRs now carry a correction banner; readers must follow the link.

**Reconciliation note (LIA-445, 2026-07-18):** A plan-review cycle for
E3/LIA-422 cited the bullet above verbatim as evidence that `deus-native` runs
unguarded, without cross-referencing either Update section below it. First-hand
re-verification: `src/agent-runtimes/middleware-stack.ts`'s `wardens`
`wrapToolCall` (comment-labeled "Wardens layer — REAL enforcement
(C1/LIA-409)") genuinely spawns the unchanged `scripts/codex_warden_hooks.py`
subprocess and fails closed to REVISE on any runner error;
`src/agent-runtimes/deus-native-backend.ts` genuinely composes it into the
production `buildMiddlewareStack(...)` call inside `runTurn`
(permissions → wardens → memory → telemetry) — not a built-but-unwired
facade; `middleware-stack.warden-gates.oracle.test.ts` pins that a blocked
`apply_patch`/commit-shaped `Bash` call never invokes the tool handler while
an allowed call delegates exactly once. **However**, none of that fires today:
`SAFE_TOOL_NAMES` never exposes `apply_patch`/`Bash` on the live deus-native
tool surface, so the wardens trigger is real-but-dormant, exactly as the ADR's
own C5 update already states. **Net effect for E3/LIA-422:** the premise "C1
built the enforcement mechanism" is TRUE and verified; the premise "so
deus-native pipeline issues run warden-guarded today" is FALSE until a
separately-reviewed widening of `SAFE_TOOL_NAMES` (isolation review +
`docs/decisions/deus-v2-replay-safety.md` contract, per
`deus-native-backend.ts`'s own documented precondition) lands. E3 does not
inherit a blanket green light from this reconciliation — its own plan must
either (a) demonstrate its Linear-pipeline dispatch path does not require
`apply_patch`/commit-shaped `Bash` at all, or (b) explicitly scope in the
`SAFE_TOOL_NAMES` widening plus its required isolation/replay-safety review
as part of E3's own work, and get that scoped plan through its own
plan-reviewer pass before implementation.

## Remediation options (deferred — NOT greenlit)

1. **Build the host-side HookPipeline (root fix).** Deus owns an Agent-SDK
   `query()` loop with in-process programmatic hooks that can block. This is the
   unbuilt design from `hook-dispatch-system.md`. Largest effort; the only path
   that gives real gates on a non-Claude backend.
2. **Path (a) for Odysseus-as-GUI.** Odysseus Chat → a new Deus
   `/v1/chat/completions` web channel → **headless Claude Code**. Hooks survive
   *only if* headless Claude Code actually loads and fires the
   `.claude/settings.json` deny gates — **to be verified before committing**;
   this is the load-bearing assumption for the entire path. Medium effort. The
   Odysseus client-timeout analysis (it is a time-to-first-token limit, not a
   total-completion cap — satisfiable by an early-delta + keepalive shim) and the
   remaining de-risks live in the handoff + research report under References.
   Implementation-volatile detail is kept out of this ADR deliberately.
3. **Accept + document only (this ADR).** Build nothing until a non-Claude-gate
   need is real.

## Alternatives considered

- **Silently amend the two ADRs in place.** Rejected — erases the discovery and
  the "why," violating the decision-log's purpose and the data-integrity rule
  (don't overwrite, augment).
- **Delete `hook-dispatch-system.md`.** Rejected — it is a sound *design*; the
  problem is its Status, not its content. Keep it as the reference design.
- **Mark it "Superseded."** Rejected — nothing supersedes it yet; it is simply
  unbuilt. "Accepted but Not Implemented" is the honest state.

## Reversibility

Pure documentation. If the HookPipeline is later built, supersede this ADR with
an "implemented" note and restore `hook-dispatch-system.md` to plain
**Accepted** (or **Implemented**). Removing the banners reverts the prior ADRs.

## References

- Deep-research report (vault): `Research/2026-06-07-odysseus-as-deus-gui-and-hook-coupling.md`
- Handoff (vault): `Handoffs/2026-06-07-17-23-odysseus-as-deus-gui.md`
- Shipped bridge PR: https://github.com/sliamh11/Deus/pull/715
- Source pointers: `.claude/settings.json`, `.claude/hooks/warden-shim.sh`,
  `scripts/codex_warden_hooks.py`, `src/message-orchestrator.ts`,
  `src/agent-runtimes/openai-backend.ts`, `src/agent-runtimes/container-backend.ts`,
  `container/agent-runner/src/pre-tool-use-hook.ts`,
  `container/agent-runner/src/hook-dispatch-service.ts`
- Tracking: a Linear issue in the **Deus** project should mirror this ADR's
  remediation options (creation was blocked by the session permission
  classifier; file it on approval).

## Update (F2/LIA-424 — 2026-07-16)

C1/LIA-409 has now built remediation Option 1's root-fix outcome for the
`deus-native` backend specifically. Its host-side LangChain middleware invokes
the unchanged `scripts/codex_warden_hooks.py` plan-review, code-review,
AI-engineering, and verification gates from `wrapToolCall`, alongside the B7
permission evaluator. For `deus-native`, that ordered `wrapToolCall` chain is
the sole authoritative pre-execution enforcement path: the runtime has no
container, no `:3002` client, and no caller into the container runner's
PreToolUse hook. LIA-424 pins this boundary with a test in which one protected
call produces one warden REVISE outcome, never invokes the tool handler, and
never consults the legacy HTTP path.

This closes the remediation gap for `deus-native`; it does not mean the generic
`AgentRuntime` `HookPipeline` interface described by
`hook-dispatch-system.md` was implemented for every backend. That broader ADR
therefore remains “Accepted but Not Implemented” outside the backend-specific
`deus-native` middleware implementation.

The container-side `pre-tool-use-hook.ts` remains in source because it still
has conditional callers in the Claude SDK adapter and the handwritten OpenAI
and llama-cpp tool loops. It is explicitly subordinate legacy compatibility
for those container backends only, not a second `deus-native` authority.
`HookDispatchService` on `:3002` is retired from active production
enforcement: it starts only when `HOOK_DISPATCH_ENABLED === "true"`, the
consult path immediately allows without an HTTP request otherwise, and no
repository launcher or production configuration sets that flag. The dormant
manual opt-in remains available for compatibility and continues to fail open.

Consequently, the non-`deus-native` guardrail story remains narrower. With the
flag unset, `:3002` contributes no enforcement to the container Claude,
OpenAI, or llama-cpp paths. If manually enabled, it supplies only the legacy
recursive-force-`rm`-outside-`/workspace` guard; it does not provide C1 warden
parity. Provider- or Claude-specific project hooks are separate mechanisms and
are not evidence that the model-neutral `HookPipeline` exists.

## Update (C5/LIA-413 — 2026-07-17)

The Claude Code hook path now has a temporary, configurable double-enforcement
window for migration measurement. When `DEUS_WARDEN_DOUBLE_ENFORCEMENT=1`, the
live `.claude/hooks/warden-shim.sh` shadows only the trigger intersection that
the `deus-native` wardens middleware currently defines: literal
`apply_patch` for plan review and commit-shaped literal `Bash` for code review,
AI-engineering review, and verification. The shim captures the event once,
mints one correlation ID, runs the Claude hook synchronously, and launches the
same Python gate in a detached process with the middleware workspace profile.
The flag remains configurable through MH sign-off; any value other than `1`
retains the original hook invocation path.

Authority is intentionally asymmetric. The Claude hook's stdout and exit code
are the sole live tool decision. The middleware-profile invocation is
observational: its deny, error, divergence, or launch failure cannot change the
Claude result. Both tagged outcomes are appended under the event-cwd-derived
worktree bucket, independent of the middleware `--workspace-root` used for the
existing verdict store. Decision mismatch, deny-feedback mismatch, missing
counterparts, and secondary launch failure produce a separate append-only
divergence signal.

Spawn-then-disappear failures are reconciled lazily. At the next tagged touch
of the same bucket, a primary record at least 30 seconds old with no middleware
record receives one deduplicated `missing_middleware` divergence. The 30-second
threshold covers `run_ai_eng_gate()`'s two sequential Git diff subprocesses,
each bounded at 10 seconds, plus headroom. Detection latency while a bucket is
idle is intentional; later observer completion does not retract historical
evidence from either append-only stream.

This window does not instantiate or test the generic `AgentRuntime`
`HookPipeline`. It exercises two invocations of the same Python runner from the
Claude shim, with the second invocation configured like the dormant native
middleware call. The production `deus-native` safe tool set still excludes
`apply_patch` and `Bash`, so no second native authority is active and no
cross-backend enforcement claim follows from this telemetry.
