# EP-001: Extract and port the complete live hook inventory

**Status:** active
**Branch:** lia-414-hook-inventory-extraction
**ADRs consulted:** `docs/decisions/deus-v2-langchain-runtime.md` (primary — defines
the `deus-native` middleware slots this inventory maps every dispatch onto),
`docs/decisions/backend-neutral-agent-runtime.md` (the `AgentRuntime` contract
those slots implement against). `docs/decisions/hook-dispatch-system.md` and
`docs/decisions/hook-dispatch-facade-correction.md` are consulted only as
historical context for why the `:3002` `HookDispatchService` facade they
describe is NOT the destination model — `hook-dispatch-facade-correction.md`
re-statuses that facade "Accepted but Not Implemented" (deferred, unbuilt).
**Opened:** 2026-07-17
**Closed:** --

## Goal

Deus's current trigger layer is entirely Claude-Code-owned: every enforcement,
context-injection, and comprehension-check behavior fires through
`.claude/settings.json` hooks shelling out to Python/Bash scripts. The
deus-native (`langchain`-based) runtime is retiring that dependence one slot
at a time (see `deus-v2-langchain-runtime.md`), but nothing has ever listed
**every single live dispatch** in one place with an explicit disposition. This
EP is that inventory: every hook dispatch declared in this repo's own
`.claude/settings.json`, mapped to a target `deus-native` middleware/lifecycle
slot, with a disposition of `port` (already wired), `port-later` (belongs in
deus-native, not wired yet), or `drop-with-reason` (Claude-Code-specific, no
deus-native equivalent).

Done means: the table below accounts for 100% of the dispatches in
`.claude/settings.json` as of the extraction date, every row has an event,
matcher (where applicable), target slot, and disposition, every
`drop-with-reason` row states a concrete reason, and
`scripts/hook_inventory_check.py` passes (fresh extraction identity-matches
this table).

## Source of truth

- **Extraction date:** 2026-07-17
- **Source path:** `.claude/settings.json` — **this deus-v2 repo's own
  committed copy**, the file this repo's CI actually reads and checks. This is
  explicitly NOT any host or Deus-V1 (`sliamh11/Deus`) copy of
  `~/.claude/settings.json` — a different repo's config is not in scope and
  would produce a silently wrong inventory if substituted here.
- **Completeness check:** `scripts/hook_inventory_check.py` — re-extracts the
  live dispatch list from `.claude/settings.json` and diffs it (by count and
  by `(event, matcher, identity)` identity) against the table below. Run it
  with `python3 scripts/hook_inventory_check.py`.
- **File map:** this artifact
  (`docs/exec-plans/active/EP-001-hook-inventory-extraction.md`) + the check
  script (`scripts/hook_inventory_check.py`).

## Expected result, stated before extraction

A prior verification pass (referenced in LIA-414) pinned the 2026-07-13
snapshot at **24 dispatches**: SessionStart×3, UserPromptSubmit×2,
PreToolUse×11, PostToolUse×7, Stop×1. Re-reading `.claude/settings.json` on
this branch's fresh worktree off `deus-v2-origin/main` (extraction date
2026-07-17) confirms this **still holds — no drift**: 3 + 2 + 11 + 7 + 1 = 24,
matching exactly, including the PreToolUse breakdown (`codegraph-first-gate`
firing under two separate matcher blocks, `Bash` and `Grep|Glob`, hence
counted twice in both the 11 and the identity list below).

## Alternatives considered

| Approach | Tradeoff | Why rejected |
|----------|----------|--------------|
| Record this inventory as a permanent ADR under `docs/decisions/` | ADRs are immutable rulings; this table is expected to change every time a hook is added/removed/re-mapped | Wrong lifecycle category — this is a living artifact, not a permanent ruling. `docs/exec-plans/` exists for exactly this. |
| Hand-verify drift occasionally, no automated check | Less code to write | Silent drift defeats the point of an inventory; the whole reason for LIA-414 is "so the artifact can't silently drift from reality later" (its own AC). |
| Hardcode the expected dispatch list a second time inside the check script and diff live-vs-hardcoded | Simpler regex-free script | Duplicates the mapping data in two places (`core-behavioral-rules.md`: "Never duplicate content across files"); the table itself would no longer be authoritative and could drift from the script silently. The chosen design parses the table's own markdown, so there is exactly one place the mapping lives. |

## Chosen approach

Extract every hook dispatch directly from this repo's `.claude/settings.json`
hooks block, and record each as one row of the table below: event, matcher (if
any), the exact hook identity (the `codex_warden_hooks.py` behavior name for
shim-dispatched hooks, or the script basename for direct-invocation hooks),
target `deus-native` middleware/lifecycle slot, disposition, and reference.
`scripts/hook_inventory_check.py` re-derives the live list on demand and
parses this table's own markdown to diff against it — no second copy of the
mapping exists anywhere.

## Dispatch inventory

Legend — **Disposition**: `port` = already wired into `deus-native` (cite the
commit); `port-later` = belongs in a `deus-native` slot, not wired yet (cite a
tracked ticket where one exists); `drop-with-reason` = Claude-Code-specific
mechanism with no deus-native equivalent today (reason given inline).

| # | Event | Matcher | Hook / Behavior | Target middleware / lifecycle slot | Disposition | Reference |
|---|-------|---------|------------------|--------------------------------------|--------------|-----------|
| 1 | SessionStart | — | `session-init` | `deus-native` session-open lifecycle (`loadSessionOpenContext`, `src/agent-runtimes/deus-native-backend.ts`) — resets warden marker files (`.plan-reviewed`, `.code-reviewed`, etc.), re-syncs atom kinds, regenerates the codebase map | port-later | No ticket yet; natural fit once C2 (LIA-410) gives deus-native an explicit `workspaceRoot` for marker/bucket resolution |
| 2 | SessionStart | — | `linear_pending_hook.py` | `deus-native` session-open lifecycle, alongside D2/D4's vault + `CLAUDE.md`/`AGENTS.md` loading | port-later | No ticket yet; script is already backend-agnostic (syncs Linear pending tasks into vault `CLAUDE.md`), just not invoked from `deus-native` |
| 3 | SessionStart | — | `session_preflight_hook.py` | `deus-native` session-open lifecycle | port-later | No ticket yet; concurrent-session collision warning is backend-agnostic, not yet wired for `deus-native` sessions |
| 4 | UserPromptSubmit | — | `memory_retrieval_hook.py` | `buildMemoryMiddleware`'s `beforeModel` slot (`src/agent-runtimes/middleware-stack.ts`) | **port** | **D1/LIA-415** (`f811d88d`) — one `beforeModel` retrieval per control-group turn through the unchanged `scripts/memory_retrieval_hook.py`; non-control groups tracked as `AAG-014` |
| 5 | UserPromptSubmit | — | `migration-nudge` | `beforeModel` context-append, same append-a-message pattern `buildMemoryMiddleware` already uses | port-later | No ticket yet; DB-migration reminder (`npm run migrate`) is unrelated to Claude Code, only its current delivery mechanism (`hookSpecificOutput.additionalContext`) is CC-specific |
| 6 | PreToolUse | `Write\|Edit\|MultiEdit\|apply_patch\|ExitPlanMode` | `plan-review-gate` | `buildWardensMiddleware`'s `wrapToolCall` (`src/agent-runtimes/middleware-stack.ts`), triggered on literal `apply_patch` | **port** | **C1/LIA-409** (`e8cb872b`) |
| 7 | PreToolUse | `Write\|Edit\|MultiEdit\|apply_patch\|ExitPlanMode` | `tdd-test-lock.sh` | wardens/permissions `wrapToolCall`, gated on `Write\|Edit\|MultiEdit\|apply_patch` | port-later | No ticket yet; dormant even once ported — `deus-native`'s live tool surface (`SAFE_TOOL_NAMES = {web_search, web_fetch}`) has no file-edit tool for this to gate |
| 8 | PreToolUse | `ExitPlanMode\|Task\|Agent` | `plan-mode-invalidator` | wardens `wrapToolCall` / marker-invalidation | port-later | Adjacent to **C2 (LIA-410)** — clears the `.plan-reviewed` marker via worktree/cwd resolution that C2's explicit-`workspaceRoot` change replaces; also has no `ExitPlanMode`/`Task`/`Agent`-shaped tool call in `deus-native` today beyond B8's `dispatch_nested_agent` |
| 9 | PreToolUse | `Write\|apply_patch` | `placement-guard` | wardens/permissions `wrapToolCall` | port-later | No ticket yet; dormant for the same file-tool-surface reason as row 7 |
| 10 | PreToolUse | `Bash` | `code-review-gate` | `buildWardensMiddleware`'s `wrapToolCall`, commit-shaped `Bash` trigger | **port** | **C1/LIA-409** (`e8cb872b`) |
| 11 | PreToolUse | `Bash` | `ai-eng-gate` | `buildWardensMiddleware`'s `wrapToolCall`, commit-shaped `Bash` trigger | **port** | **C1/LIA-409** (`e8cb872b`) |
| 12 | PreToolUse | `Bash` | `verification-gate` | `buildWardensMiddleware`'s `wrapToolCall`, commit-shaped `Bash` trigger | **port** | **C1/LIA-409** (`e8cb872b`) |
| 13 | PreToolUse | `Bash` | `admin-merge-gate` | wardens `wrapToolCall`, `gh pr merge --admin`-shaped `Bash` trigger | port-later | Adjacent to **C2 (LIA-410)** — reads the verdict store's SHIP markers (`_evaluate_standing_grant`) that C2's explicit-`workspaceRoot` bucket resolution changes |
| 14 | PreToolUse | `Bash` | `format-check.sh` | wardens/permissions `wrapToolCall`, git-commit-shaped `Bash` trigger | port-later | No ticket yet; mechanical `prettier --check` gate, independent of the warden-verdict lifecycle; dormant until `deus-native` has a live `Bash` tool |
| 15 | PreToolUse | `Bash` | `codegraph-first-gate` | none — see reason | drop-with-reason | Reads `event["transcript_path"]`, a Claude Code session JSONL transcript, to detect a prior codegraph MCP tool call before allowing a Grep/Glob/Bash-search call (`run_codegraph_first_gate`, `scripts/codex_warden_hooks.py:1265-1301`). `deus-native` keeps no equivalent transcript file, and its live tool surface (`SAFE_TOOL_NAMES = {web_search, web_fetch}` in `tool-broker-langchain-adapter.ts`) exposes none of Grep, Glob, Bash, or a codegraph MCP tool for this gate to apply to. No deus-native equivalent exists today. |
| 16 | PreToolUse | `Grep\|Glob` | `codegraph-first-gate` (second matcher) | none — see reason | drop-with-reason | Same behavior and same reason as row 15 — this is the ticket's "codegraph-first-gate ×2 matchers" second dispatch, not a distinct hook |
| 17 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `code-review-invalidator` | wardens `wrapToolCall` / verdict-store invalidation | port-later | Adjacent to **C2 (LIA-410)** — clears the `.code-reviewed` marker via the same managed-paths/worktree resolution C2 changes; dormant until `deus-native` exposes a live file-edit tool |
| 18 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `threat-model-gate` | wardens `wrapToolCall` | port-later | No ticket yet; config-gated warden (`_warden_enabled(config, "threat-modeler")`), same dormant-tool-surface reason as row 17 |
| 19 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `path-leak-detector` | wardens `wrapToolCall` | port-later | No ticket yet; scans touched paths for `$HOME`-prefixed leaks, same dormant-tool-surface reason as row 17 |
| 20 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `verification-invalidator` | wardens `wrapToolCall` / verdict-store invalidation | port-later | Adjacent to **C2 (LIA-410)**, same marker/workspaceRoot reason as row 17 |
| 21 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `cold-memory-injector` | memory middleware family (`buildMemoryMiddleware`, alongside D1/D3's `beforeModel`/re-embed hooks) | port-later | No ticket yet; config-gated context injector over touched paths (`_warden_enabled(config, "cold-memory-injector")`), same dormant-tool-surface reason as row 17 |
| 22 | PostToolUse | `Write\|Edit\|MultiEdit\|apply_patch` | `structural-check` | wardens `wrapToolCall` | port-later | No ticket yet; config-gated warden over touched paths, same dormant-tool-surface reason as row 17 |
| 23 | PostToolUse | `Agent` | `warden-verdict-tracker` | wardens verdict-store write path (records `Agent`-dispatched warden-subagent verdicts, keyed off `WARDEN_SUBAGENT_TYPES`) | port-later | Adjacent to **C3 (LIA-411)** — verdict tracking is only meaningful once `deus-native` actually dispatches warden subagents through B8 the way C3 describes; no `Agent`-shaped warden dispatch exists in `deus-native` today |
| 24 | Stop | `""` | `nonumb-gate.sh` | none — see reason | drop-with-reason | Comprehension-quiz doorbell keyed to a Claude Code interactive session's Stop event: it scans `transcript_path` (a Claude Code JSONL transcript) for `Edit`/`Write`/`MultiEdit`/`NotebookEdit` `tool_use` blocks since the last user prompt, then blocks via the CC-specific `{decision:"block", reason}` Stop-hook contract, instructing Claude to invoke the `/quiz-me` Skill (a Skill-tool + `AskUserQuestion` interaction, `.claude/hooks/nonumb-gate.sh:100-109`). `deus-native` has no Skill tool, no `AskUserQuestion` tool, no Stop-hook re-entry contract, and no on-disk transcript in this format. No deus-native equivalent exists today. |

**Totals:** 24 dispatches — 5 `port` (4 commit-path gates via C1 + memory
retrieval via D1), 16 `port-later`, 3 `drop-with-reason`
(`codegraph-first-gate` ×2 matchers, `nonumb-gate.sh`).

## Progress checklist

- [x] Fresh-extract the dispatch list from this repo's own `.claude/settings.json`
- [x] Map every dispatch to an event, matcher (where applicable), target slot, and disposition
- [x] Give every `drop-with-reason` row a concrete reason
- [x] Cite C1 for the 4 commit-path gates and D1 for memory retrieval
- [x] Add `scripts/hook_inventory_check.py` and verify it passes against this table
- [ ] Re-run the completeness check whenever `.claude/settings.json` changes; update this table in the same commit if it fails

## Decision log

| Date | Decision | Reasoning |
|------|----------|-----------|
| 2026-07-17 | Filed under `docs/exec-plans/active/`, not `docs/decisions/` | This tracks live `.claude/settings.json` state over time rather than ruling on a fixed architecture choice; `docs/decisions/` ADRs are explicitly not meant to be edited as reality drifts. |
| 2026-07-17 | Completeness check parses this table's own markdown rather than embedding a second hardcoded dispatch list | Avoids exactly the duplication-drift risk the check exists to prevent — the table is the only place the intended mapping is recorded. |
| 2026-07-17 | `codegraph-first-gate` (both matchers) and `nonumb-gate.sh` marked `drop-with-reason` rather than `port-later` | Both depend on mechanisms `deus-native` structurally lacks today (a Claude Code JSONL transcript file, the Skill/`AskUserQuestion` tools) rather than merely a not-yet-widened tool surface — the distinction the other `port-later` rows share (dormant only until file-edit tools land). |
