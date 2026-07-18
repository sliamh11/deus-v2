# Deus v2: LangChain-Based Host-Side Agent Runtime (deus-native)

**Status:** Accepted
**Date:** 2026-07-15
**Scope:** `src/agent-runtimes/deus-native-backend.ts`, `src/agent-runtimes/tool-broker-langchain-adapter.ts`, `src/agent-runtimes/types.ts`, `src/index.ts`, `package.json`
**Related:**

- `multi-agent-orchestration-research.md` — evaluated Runner/LLM placement options in May 2026 and rejected "Runner on host, LLM on host". This ADR partially supersedes that rejection (see Consequences).
- `backend-neutral-agent-runtime.md` — defines the `AgentRuntime` contract, credential boundary ("adapters must not read raw host secrets"), and context-parity requirement this adapter implements against. Not superseded.

## Context

Deus's agent execution has been backend-neutral since `backend-neutral-agent-runtime.md`
(2026-04-23), but every registered backend (`claude`, `openai`, `llama-cpp`) is a thin
wrapper around the same `ContainerRuntime`: the agentic loop itself runs inside an
isolated container, driven by the Claude Agent SDK (or the OpenAI/llama.cpp drivers)
rather than by Deus-owned code.

The deus-v2 decision (2026-07-13, tracked as the 49-issue roadmap in Linear project
db126dc4; this file is its first repo-committed record) is to retire that dependence:
Deus owns its own agentic loop, built on LangChain JS `createAgent` plus a Deus-owned
middleware stack, running **in-process on the host**. The A-milestone walking skeletons
(LIA-394 through LIA-400) validated the load-bearing assumptions one by one:
tool-broker reuse through a pure LangChain adapter (A1), provider override (A3),
credential-proxy routing with placeholder credentials for both OAuth and API-key
modes (A4), MCP adapters (A5), SQLite checkpointing (A6), and tool-loop reliability
(A7). B1 (LIA-401) turns that validated shape into the first production-registered
`AgentRuntime` adapter, selectable via `DEUS_AGENT_BACKEND=deus-native`.

This directly conflicts with `multi-agent-orchestration-research.md` (Accepted,
2026-05-06), which evaluated three Runner/LLM placement options and rejected
"Runner on host, LLM on host" with the reasoning: "Containers become tool sandboxes.
Loses Claude Agent SDK autonomous loop. Massive rewrite, loses core strength."
A1's spike write-up explicitly flagged that a production host-side proposal requires
its own ADR superseding or reconciling with that rejection. This is that ADR.

## Decision

1. **Adopt LangChain JS `createAgent` as the engine of a new host-side
   `AgentRuntime` adapter, `deus-native`**, registered in the existing runtime
   registry alongside `claude`/`openai`/`llama-cpp` and selected through the
   existing `DEUS_AGENT_BACKEND` mechanism. This is a Strategy-pattern addition:
   no new abstraction is introduced; the `AgentRuntime` interface Deus already
   owns is reused as-is.
2. **The May 2026 rejection's primary reason is moot by design.** "Loses the
   Claude Agent SDK autonomous loop" was a cost when the SDK loop was the core
   strength; deus-v2's entire premise is to replace that loop with a Deus-owned
   one. The rejection is reversed for this specific case — see Consequences.
3. **The rejection's implicit second reason — losing container-grade
   tool-execution isolation — is still true and is NOT mooted.** The tool broker's
   `bash_exec` spawns `/bin/bash -lc` with the full inherited environment and no
   resource limits, and `resolveWorkspacePath` hardcodes container-only
   `/workspace/*` roots that were never designed as a host boundary. No OS-level
   sandboxing primitive exists in this repo. Therefore `deus-native` ships with a
   **conservative tool surface**: only `web_search`/`web_fetch` (the two broker
   tools that neither spawn shells nor touch `resolveWorkspacePath`), with
   `web_fetch` behind a code-level host allowlist. `bash_exec`/`read_file`/
   `write_file`/`edit_file`/`glob_files`/`grep_files` are explicitly not wired
   until the permission-rules engine (B7/LIA-407, `wrapToolCall`) or an
   equivalent stopgap exists. `capabilities()` reports `shell: false,
filesystem: false` accordingly. **`web_search` is NOT host-allowlisted**
   (added per ai-eng-warden review, round 1): its destination is fixed
   (DuckDuckGo), so it's exempt from `withHostAllowlist`, but its query
   string is model-controlled and sent verbatim — it is the one always-on
   network-egress channel this adapter exposes, and a hijacked turn could use
   it to leak text to a third party regardless of the `web_fetch` allowlist
   setting. Accepted for this milestone given the tool's fixed destination
   and the prompt-injection boundary added to all tool output (below); a
   query-length cap or content scrub would need its own review if adopted.
   All broker-tool output re-entering the model's context is wrapped in an
   explicit `<tool-output>` boundary with an "untrusted data, not
   instructions" framing (`tool-broker-langchain-adapter.ts`), since
   `runTurn` sends no system prompt (see Decision 5) and the model would
   otherwise have no signal distinguishing fetched/searched content from a
   command.
4. **Credential boundary is preserved.** The adapter holds no raw secrets: it
   targets the live credential proxy at `PROXY_BIND_HOST:CREDENTIAL_PROXY_PORT`
   with placeholder credentials (branching on `detectAuthMode()` for OAuth vs
   API-key mode) and a per-group `x-deus-proxy-token`, exactly as the container
   backends do — satisfying `backend-neutral-agent-runtime.md`'s "must not read
   raw host secrets" requirement.
5. **Context parity is phased.** B1's `runTurn` originally sent the bare
   prompt only. B3/D2 added the session-open lifecycle and personal-vault
   aggregate; D4/LIA-418 now loads the applicable `CLAUDE.md`, `AGENTS.md`,
   and `AI_AGENT_GUIDELINES.md` files through mount-equivalent group, global,
   project, vault, and additional roots. This closes the three accepted
   instruction-file gaps without claiming persona, `MEMORY_TREE.md`, solution
   atom, or broader memory parity.
6. **publicIngress (webhook-originated) groups are refused, fail-closed**
   (added per code-review). `container-runner.ts`'s `buildContainerArgs`
   already refuses to launch a publicIngress group on any backend but
   `claude`, since the reduced-privilege curated-tool profile it enforces is
   claude/container-only — its own comment states "refuse to launch rather
   than silently downgrade isolation." `deus-native` never calls that
   function (it is not a `ContainerRuntime` wrapper), so without an
   independent check a publicIngress group routed to `deus-native` would run
   with an unscoped proxy token and the full `web_search`/`web_fetch`
   surface instead of the curated webhook profile — the exact silent
   downgrade the container-path guard exists to prevent. `DeusNativeRuntime.
runTurn` mirrors the same rule directly (returns a `status: 'error'`
   result before minting any token or constructing a model), matching the
   per-backend enforcement pattern `buildContainerArgs` already uses rather
   than introducing a new centralized mechanism.
7. **Two-tier architecture, named (LIA-388 M0.1 record).** Per the
   2026-07-13 base-harness-selection research
   (`Research/2026-07-13-deus-v2-base-harness-selection.md`), deus-v2 is a
   two-tier architecture: **Tier 1 — Deus Runtime**, the product harness
   that replaces Claude Code for Deus's own product surfaces (channels,
   containers, web UI, scheduled tasks) — the `deus-native` `AgentRuntime`
   this ADR adds. **Tier 2 — Interactive clients**, the user's choice of
   dev CLI (Claude Code, Codex, OpenCode) for developing this repository
   and its gate logic — not `AgentRuntimeId` product-backend values. This
   repository is itself developed via Tier-2 Claude Code sessions (see the
   `.claude/` gate configuration here) while `deus-native` is the Tier-1
   target for the shipped product; `claude`/`openai`/`llama-cpp` remaining
   registered `AgentRuntimeId` product-backend values (Decision 1) is a
   separate axis from Tier-2 dev-CLI choice — it does not contradict this
   file's own "Related" note above that `backend-neutral-agent-runtime.md`
   is Not superseded. This record names the two tiers; it does not resolve
   the open question (flagged under "Backend, provider, and CLI selection"
   above) of what `deus`/`deus claude`/`deus codex` mean after
   `deus-native` becomes the default — that remains G1's (LIA-428) to
   answer.
8. **Repository and rollout strategy (LIA-388 M0.1 record).** The
   2026-07-13 research report's migration-style note states explicitly:
   **"No new repo needed for the runtime... V2 lands as a long-lived
   feature branch/worktree with per-slice PRs to main behind flags."** At
   that decision point the strategy was a dedicated git worktree/feature
   branch inside the original `Deus` repository, per-slice PRs merging
   independently to that repo's `main` behind
   `DEUS_AGENT_BACKEND=deus-native`, explicitly rejecting a wholesale-merge
   integration branch that would land every milestone as one giant diff.
   **Correction:** that "no new repo" premise did not hold. GitHub records
   `sliamh11/deus-v2` (this repository) as created 2026-07-16T10:14Z — all
   V2 work has since migrated out of the original `Deus` repo
   (`sliamh11/Deus`) into this dedicated sibling repository. The
   per-slice-PR discipline and the rejection of a wholesale-merge
   integration branch are unchanged by that correction: every milestone
   referenced in Consequences below (B1, B4, B7, B8, C1, D1-D4, …) landed
   as its own reviewed PR to this repo's `main`, never as a bulk merge.
   `DEUS_AGENT_BACKEND=deus-native` remains the sole migration flag gating
   cutover regardless of which repository hosts the code.

## Alternatives Considered

- **Keep the container-based Claude Agent SDK loop as the permanent engine
  (status quo).** Rejected by the deus-v2 decision itself: it leaves Deus's core
  agentic behavior owned by a vendor harness, limits middleware/hook control,
  and makes the loop unswappable.
- **Runner on host, LLM in container (bridged).** Already rejected in
  `multi-agent-orchestration-research.md` for impedance mismatch — the runner
  cannot orchestrate individual turns inside a container. Still rejected; the
  deus-v2 pivot does not change this.
- **Run the LangChain loop inside the container.** Preserves the sandbox but
  re-creates the exact problem deus-v2 retires: the host cannot own middleware,
  hooks, checkpointing, or per-turn control across the container boundary
  without rebuilding an IPC protocol equivalent to the one being retired.
  Rejected for B1; per-tool sandboxing (B7+) is the chosen isolation path
  instead.
- **Ship B1 with the full tool-broker surface and rely on
  `DEUS_AGENT_BACKEND` opt-in as the safety gate.** Rejected by threat-model
  review: backend selection is a soft, global `.env`-flippable default with no
  per-call gate; it is defense-in-depth, not a sandbox. The conservative
  web-only tool surface is the actual boundary.

## Consequences

- **This ADR supersedes the "Runner on host, LLM on host: Rejected" line of
  `multi-agent-orchestration-research.md` (its Architectural Finding table,
  line 37) for the deus-native case.** The rejection's stated reason — losing
  the Claude Agent SDK's autonomous loop — no longer applies, because deus-v2
  deliberately retires that loop in favor of a Deus-owned LangChain loop. The
  rest of that ADR (interface renames, orchestrator patterns 1–2, guardrail/
  tracing concepts, the other two placement rejections) stands unchanged. The
  independent tool-isolation concern embedded in that rejection is addressed
  separately by this ADR's conservative tool scope, not by the supersession.
- The container backends (`claude`/`openai`/`llama-cpp`) remain registered,
  default, and unchanged. `deus-native` is reachable only by explicit
  `DEUS_AGENT_BACKEND=deus-native` (or group/task override).
- `langchain`, `@langchain/core`, `@langchain/anthropic`, and
  `@anthropic-ai/sdk` move from `devDependencies` to `dependencies`: the
  adapter is imported unconditionally at `src/index.ts` startup, so a
  production install that omits dev dependencies would otherwise crash on boot
  even when `deus-native` is never selected. The remaining `@langchain/*`
  spike-only packages stay in `devDependencies` until a production import
  exists.
- Host-side tool execution grows one production surface (web fetch/search) with
  no container between the model and the host. The allowlist decorator and the
  web-only inclusion filter are the security boundary; widening the tool
  surface requires B7's permission engine (or equivalent) first, plus its own
  review.
- **Update (B7/LIA-407):** the permission engine referenced above has since
  landed — see `deus-v2-permission-rules.md` for the declarative allow/deny
  rule evaluator and its `default`/`read-only` named profiles. `SAFE_TOOL_NAMES`
  (`tool-broker-langchain-adapter.ts:124`) is unchanged at `{web_search,
web_fetch}` and remains the operative boundary; B7 added an authorization
  layer behind that boundary, it did not widen it. Any future widening still
  requires its own separate review per this ADR's Decision 3.
- B4 has since landed real checkpoint-backed session persistence, and D2/D4
  have landed the session-open vault aggregate and three-file repository
  registry. Broader persona, memory, tool, and middleware parity remains
  phased; these additions do not by themselves make `deus-native` a complete
  parity backend.
- **Update (D1/LIA-415):** the middleware stack's memory slot is now filled
  for CONTROL-GROUP turns: `buildMemoryMiddleware` performs one `beforeModel`
  retrieval per turn through a narrow subprocess adapter
  (`src/agent-runtimes/memory-retrieval.ts`) over the byte-for-byte unchanged
  `scripts/memory_retrieval_hook.py`, appending non-empty recalled context to
  the model input as a user-role message and failing open (no context, turn
  proceeds) on empty/malformed output, timeout, or process failure.
  Non-control groups deliberately keep the pass-through observer — the hook
  reads the user's personal vault and is not group-scoped; that parity gap is
  tracked as `AAG-014` in `docs/agent-agnostic-debt.md`. This fills the
  existing memory slot only: it does not reopen this ADR's runtime choice and
  claims no broader hook-pipeline parity (the general host `HookPipeline`
  remains unimplemented per `hook-dispatch-facade-correction.md`).
- **Update (B8/LIA-408):** nested subagent dispatch has since landed — see
  `deus-v2-subagent-dispatch.md` for the in-process, one-shot nested
  `createAgent` dispatch primitive and its `dispatch_nested_agent` tool. It
  is governed as an EXTENSION of this ADR's `runTurn()` loop, not a
  parallel agent-execution path: a dispatched child receives a fresh
  instance of the SAME conservative web-only tool surface this ADR
  establishes (Decision 3), the same credential-proxy routing (Decision 4),
  and never receives `dispatch_nested_agent` itself (no recursive nesting).
  `SAFE_TOOL_NAMES` remains unchanged and is still the operative tool-surface
  boundary for every child, exactly as it is for the parent.
- **Update (D3/LIA-417):** that same memory middleware now also contains a
  post-success `wrapToolCall` mechanism for edit-triggered re-embedding. It
  maps supported broker-shaped (`write_file`/`edit_file`) and existing-hook-
  shaped (`Write`/`Edit`/`MultiEdit`) calls onto the unchanged
  `scripts/memory_tree_hook.py` PostToolUse protocol, invokes the hook only
  after the delegated tool succeeds, and fails open if hook launch fails.
  This mechanism is unit-complete but currently dormant: `SAFE_TOOL_NAMES`
  still exposes only `web_search` and `web_fetch`, so no live `deus-native`
  tool can activate it. If a separately reviewed future decision widens that
  inclusion set to supported filesystem edit tools, the middleware branch
  becomes live automatically; LIA-417 neither authorizes nor implements that
  widening. The `claude` backend is unchanged and continues to re-embed
  independently through its existing `Write|Edit|MultiEdit` PostToolUse hook.
- **Update (D4/LIA-418):** session-open composition now appends a host-side
  declarative context registry after D2's unchanged vault aggregate. The
  registry mirrors the real container mount topology and fixed instruction
  filename order for group/global/project/vault/additional scopes. In
  particular, only the control group can resolve the literal personal-vault
  root, project resolution is worktree then registered project then
  control-only daemon-root fallback (with no cwd step), and additional mounts
  pass through the existing allowlist validator. This closes only the three
  instruction-file gaps; persona and broader memory surfaces remain separate.

## Addendum: F1/LIA-423 Container Protocol Portability (2026-07-17)

F1 adds a `deus-native` driver inside `container/agent-runner` as an additive,
non-default protocol-portability proof. A caller that directly supplies
`ContainerInput.backend: 'deus-native'` can now run a LangChain `createAgent`
turn through the existing stdin-JSON, stdout-marker, IPC follow-up, session-ref,
credential-proxy, and container-isolation contract. The driver explicitly pins
`agent.invoke(..., { recursionLimit: 25 })` to bound each agent/tool graph run.

This does **not** reverse this ADR's decision that production `deus-native`
execution is host-owned. `DEUS_AGENT_BACKEND=deus-native` and ordinary
group/task resolution continue to select the host-native `DeusNativeRuntime`;
`ContainerBackendId` still excludes `deus-native`, and the production registry
contains no `ContainerRuntime('deus-native', ...)` registration. Moving the
production runtime into a container would still require an explicit new
decision covering middleware, hooks, checkpointing, context ownership, and
per-turn control. F1 supplies no such caller or migration.

The container driver binds the full existing broker/MCP tool catalog because
those tools execute behind the same container boundary already relied on by
the Claude, OpenAI, and llama.cpp drivers. That license is non-transferable:
it does **not** authorize widening the host adapter's `SAFE_TOOL_NAMES` in
`src/agent-runtimes/tool-broker-langchain-adapter.ts`. The host remains
web-only because it has no equivalent OS sandbox around tool execution. The
container driver also refuses `DEUS_TOOL_PROFILE=webhook` before model or tool
initialization, preserving the Claude-only curated public-ingress boundary.

F1 preserves session identity and metadata across the container IPC follow-up
loop, but its conversation messages are process-local, like the existing
llama.cpp driver; durable cross-container resume and host middleware/checkpoint
parity remain explicitly deferred as `AAG-016`. The new path does not consult
or enable the legacy `HOOK_DISPATCH_ENABLED`/`:3002` gate, so
`hook-dispatch-facade-correction.md` requires no corresponding update.

## Addendum: F4/LIA-426 Skill Instruction-Pack Loading (2026-07-18)

F4 adds `container/agent-runner/src/skill-context-loader.ts`, a lazy
discovery/injection module for `SKILL.md` instruction packs inside F1's
`deus-native` container driver, plus one bound tool: `load_skill`, a local,
read-only instruction resolver. This does not widen F1's tool-parity license
described above — `load_skill` is not a broker/MCP tool, executes no code,
and grants no new capability; `deus-native-backend.ts`'s bound-tools
invariant test now explicitly pins it as the sole permitted non-broker name.

Skill discovery is a Registry (`RuntimeSkillRegistry`) built once per
container conversation from the same personal/project/extra roots
`context-registry.ts` already reads `AGENTS.md`/`CLAUDE.md` from. Instruction
bodies are injected UNWRAPPED (no untrusted-content sentinel), matching that
existing precedent — this is parity with an accepted trust posture (and with
Claude Code's own baseline auto-invoked project/user skills), not a new
attack surface. A discriminated-union result (`ok: true | false`) reports
missing/invalid/unsupported/not-invocable skills as an actionable, HANDLED
turn result (`status: 'success'`), never a transport-level error — the same
discipline the container IPC protocol already requires elsewhere.

This is a strictly separate mechanism from `skill-mcp-registry.ts`'s
executable MCP tool registration (skills shipping real code via
`agent.js`/`agent.ts`, e.g. `x-integration`) — F4 does not touch that path,
and the two pre-existing breaks it does not repair (`x-integration`'s broken
MCP registration, `add-ollama-tool`'s hardcoded MCP server list) are
explicitly preserved as recorded limitations, both excluded from the
model-invocation catalog and returning their documented disposition on
direct invocation. See `docs/KNOWN_LIMITATIONS.md`.

## References

- Deep-research report (vault): `Research/2026-07-13-deus-v2-base-harness-selection.md`
  — the 9-candidate evaluation against five hard requirements (blocking
  tool-call interception, session-lifecycle events, subagent dispatch with
  per-agent model selection, MCP consumption, TypeScript embeddability) that
  selected LangChain JS 1.x for Decision 1, and the source of the Tier
  1/Tier 2 naming and repo/rollout strategy in items 7-8 above.
- This ADR is one link in a correction/supersession chain over the
  pre-deus-v2 hook-dispatch design, recorded across sibling ADRs rather than
  duplicated here (extending the single passing mention above, in the
  D1/LIA-415 update, into a structured pointer):
  - [hook-dispatch-system.md](hook-dispatch-system.md) — the original
    "Model-Agnostic Hook Dispatch System" design (Accepted 2026-05-14). Its
    banner states the explicit transition condition: Status flips to
    Implemented-via-V2 only when the generic `AgentRuntime` `HookPipeline`
    facade also ships for container backends (or is explicitly descoped) —
    C1/LIA-409's `deus-native`-specific `wrapToolCall` chain closes only the
    tool-call-interception half of that scope, not the whole.
  - [hook-dispatch-facade-correction.md](hook-dispatch-facade-correction.md)
    — recorded the 2026-06-07 discovery that the two ADRs above described an
    unbuilt facade. Its Update (F2/LIA-424 — 2026-07-16) section records
    that C1/LIA-409 has since closed the remediation gap for `deus-native`
    specifically, and that `ADR-001-hook-dispatch-service.md`'s `:3002`
    `HookDispatchService` is retired from active production enforcement
    (default-off, no repository launcher or production configuration
    enables it) — retained only as dormant, fail-open manual container
    compatibility.
  - [ADR-001-hook-dispatch-service.md](ADR-001-hook-dispatch-service.md) —
    the `:3002` service ADR itself, banner-updated 2026-07-16 to record the
    same F2 retirement from the service's own perspective.

  None of the three files above are edited by this ADR; each already carries
  its own correction banner reflecting the current, already-landed state (not
  a future plan) as of F2/LIA-424 (2026-07-16).

## Rollback

Remove the `registry.register(createDeusNativeRuntime(...))` line in
`src/index.ts` and the `'deus-native'` member from `AgentRuntimeId`/
`parseAgentBackend`; the adapter module and its tests become dead code that can
be deleted in the same commit. No schema, data, or container changes are
involved — the sessions table's generic `backend` column simply stops seeing
the value. Dependency moves may stay (harmless) or be reverted with the code.
If rolled back, restore `multi-agent-orchestration-research.md`'s banner note
removal and INDEX.md rows in the same commit so the decision record stays
consistent.
