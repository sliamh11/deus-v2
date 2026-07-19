# EP-002: Wire deus-native's parent turn loop onto the CLI-subprocess transport (LIA-454)

**Status:** active
**Branch:** feat/lia454-parent-cli-subprocess
**ADRs consulted:** docs/decisions/deus-native-h1-production-wiring-design.md, docs/decisions/deus-native-cli-subprocess-mcp-seam.md (LIA-449)
**Opened:** 2026-07-19
**Closed:** --

## Goal

`DeusNativeRuntime.runTurn()`'s own `createAgent()`/`agent.invoke()` call
(`deus-native-backend.ts:671-701`) is the last production call site still
hitting the H1/LIA-433 raw-HTTP 429 for every real `deus-v2 chat` message.
The nested-dispatch slice (PR #47, merged `22f82ff`) already proved the
CLI-subprocess transport works for children; this EP wires the PARENT loop
itself onto the same transport, behind the existing `DEUS_NATIVE_TRANSPORT`
flag (default off). Done when: the parent loop routes through the CLI
subprocess with zero enforcement/continuity regression, a real credentialed
smoke test shows zero 429s across multi-turn conversation + compaction +
nested dispatch + a permission denial, and the A7 tool-loop-reliability
benchmark has a real production-wired target to re-run against (the A7 run
itself is a separate follow-up ticket, not part of this EP's done-criteria).

## Alternatives considered

| Approach | Tradeoff | Why rejected |
|----------|----------|--------------|
| CLI-native session continuity (`--resume`/CLI session files) as the source of truth for conversation state (§2.7 option B) | Simpler, no translation layer | Breaks the existing LangGraph context-compaction mechanism with no CLI-native equivalent — rejected by the user directly on 2026-07-19, recorded in the ADR §2.7 |
| Defer the full §3.5 process-lifecycle registry (orphan reconciliation, cross-process cap) and inherit only the nested-dispatch slice's partial `maxProcesses` mitigation | Smaller diff, faster to land | The parent loop is the real production conversation path; ADR §3.5 states full lifecycle management is required "before any production rollout," not before some later slice — deferring again would knowingly ship a not-production-ready parent transport |
| Compare-before-put re-read as the sole checkpoint-concurrency guard | No new infrastructure needed | Plan-reviewer (round 1) correctly identified this as TOCTOU-racy across processes — SQLite serializes the `put()` statement, not the read-check-write sequence; independently confirmed no existing per-`thread_id` lock exists anywhere in the codebase |

## Chosen approach

Branch `runTurn()` once on a locally-snapshotted `DEUS_NATIVE_TRANSPORT` value.
The `raw-http` branch is untouched. The `cli-subprocess` branch routes through
a new `parent-turn-runner.ts`, which spawns exactly one parent CLI
conversation via a new `parent-turn-mcp-server.ts` (exposing `web_search`,
`web_fetch`, `dispatch_nested_agent` — the parent's full tool catalog, unlike
the nested-dispatch child's two-tool catalog), translates the CLI's
`TurnResult` into canonical LangChain messages via a new
`checkpoint-translation.ts`, and persists them through the existing
`SqliteSaver` checkpointer via a direct `put()` call (§2.7 option A — chosen
over CLI-native continuity specifically to preserve context compaction with
zero behavioral gap). A new cross-process, `thread_id`-keyed exclusive turn
lease (`process-lifecycle-registry.ts`, `O_CREAT|O_EXCL` file lock under
`STORE_DIR/cli-subprocess/thread-turns/`) is acquired by BOTH transports
before the initial checkpoint read, closing a real lost-update race that
SQLite's own serialization does not close. Permissions/wardens relocate onto
the MCP tool-handler boundary via a shared `mcp-tool-gate.ts`, reused by both
the parent and child MCP servers — extending, not duplicating, the pattern
`nested-dispatch-mcp-server.ts` already proved in PR #47.

Full plan (582+ lines, file-by-file changes, 13-step sequencing, complete
test/verification strategy, risks, rollback): see the plan artifact this EP
supersedes as the working reference —
`docs/decisions/deus-native-h1-production-wiring-design.md` remains the
ADR-level design; this EP's own progress checklist below tracks
implementation against that plan's 13 sequencing steps.

**Plan provenance**: authored by GPT-5.6-Sol (per standing session rule),
went through 2 rounds of Opus plan-review (round 1: REVISE — checkpoint
concurrency race, under-specified history-ingestion acceptance bar, missing
`metadata.source` oracle assertion; round 2: SHIP, all three resolved with
independently-verified controlling facts). Every load-bearing citation in the
plan (LangGraph checkpoint API shape, `sendTurn()` signature,
`--no-session-persistence`, `SqliteSaver.put()`'s lack of compare-before-write,
`CheckpointMetadata.source` taxonomy, `PregelLoop`'s real branching on
`source !== "update"/"fork"`, absence of any existing per-`thread_id` lock)
was independently spot-checked against the actual repo/`node_modules` source
before this EP was opened — not accepted on the plan-reviewer's word alone.

## Progress checklist

- [ ] 1. Prepare isolated implementation branch (this EP; branch created off `origin/main@b6764ab`, confirmed no unrelated diff)
- [ ] 2.1 Spike: confirm `claude --version`/`--help` flag surface (`--model`, `--append-system-prompt-file`, `--no-session-persistence`, etc.)
- [ ] 2.2 Spike: history-ingestion candidate (`--append-system-prompt-file` + typed envelope) — role-fidelity + adversarial-instruction proof, latency/token acceptance bars. BLOCKING: failure returns the design to plan review.
- [ ] 2.3 Spike: real usage/model-ID capture for allow + denied-tool cycles
- [ ] 3. `TurnResult` hardening: current-turn event buffering, protocol narrowing, overflow failure
- [ ] 4. Checkpoint bridge built + verified in isolation (synthetic turn → real temp `SqliteSaver` → real `createAgent` resume)
- [ ] 5. Independent checkpoint oracle authored + run (BLOCKING tooling prerequisite: restore/obtain `dispatch-oracle-author.sh` equivalent — confirmed absent from this repo's `origin/main`, exists only in sibling `~/deus` v1 repo)
- [ ] 6. Compaction operation extracted + CLI summarizer added, verified against a real CLI-authored row
- [ ] 7. Shared security core extracted (`mcp-tool-gate.ts`) + nested-dispatch core made transport-neutral, raw-path/nested oracle tests stay green
- [ ] 8. Parent MCP server built + verified (3-tool catalog, fail-closed, policy toggles)
- [ ] 9. Full process-lifecycle registry (both lease classes) implemented + verified before production wiring
- [ ] 10. Parent-turn runner built with fakes, checkpoint-before-success invariant verified
- [ ] 11. `runTurn()` wired behind one transport decision; full existing raw-path suite still green
- [ ] 12. Real credentialed parent smoke test (`lia454_parent_turn_cli_subprocess_smoke.ts`)
- [ ] 13. Full verification/reviewer gates (code-reviewer, ai-eng-warden, verification-gate, all Opus) + ADR acceptance-table update

## Decision log

| Date | Decision | Reasoning |
|------|----------|-----------|
| 2026-07-19 | Plan drafted by GPT-5.6-Sol, not hand-authored | Standing session rule: GPT-5.6-Sol authors every implementation plan draft |
| 2026-07-19 | Round-1 plan-review REVISE on checkpoint concurrency, history-ingestion acceptance bar, `metadata.source` oracle gap | Opus plan-reviewer; all three independently verified as real gaps (no existing per-thread lock found; `--append-system-prompt-file` genuinely flattens roles; `PregelLoop` genuinely branches on source) |
| 2026-07-19 | Round-2 plan-review SHIP | All three gaps closed with concrete, independently-verified mechanisms (cross-process thread-turn lease; named history candidate + numeric latency/token bars + adversarial-instruction proof; oracle assertion exercising the real Pregel branch point) |
| 2026-07-19 | Build the FULL §3.5 process-lifecycle registry now, not a deferred follow-up | ADR §3.5 states this is required "before any production rollout" of the parent loop specifically — the parent is the real production path, unlike the nested-dispatch slice |
