---
name: LIA-449 — Native CLI-subprocess + stdio-MCP transport walking skeleton
description: >
  Evidence-based ruling on whether the native Claude CLI subprocess
  (stream-json stdin/stdout + a real stdio MCP tool) is a viable replacement
  transport for the raw-HTTP `buildProxyRoutedChatAnthropic` path that H1/
  LIA-433 found persistently 429-blocked. Records the actual 2026-07-18
  credentialed smoke-run result (17/17 assertions PASS) and scopes exactly
  what this does and does not authorize.
type: decision
tags: [deus-v2, agent-runtime, cli-subprocess, mcp, h1, lia-449, transport]
date: 2026-07-18
---

# LIA-449 — Native CLI-subprocess + stdio-MCP transport walking skeleton

**Status:** Recorded
**Date:** 2026-07-18
**Scope:** `src/agent-runtimes/cli-subprocess/` (new, isolated, unregistered
module), `scripts/spikes/lia449_cli_subprocess_mcp_walking_skeleton.ts` +
`.results.json`. Does not modify `deus-native-model.ts`,
`deus-native-backend.ts`, `nested-dispatch(-tool).ts`, the runtime registry,
or anything reachable from `DeusNativeRuntime.runTurn()` — see "Isolation"
below.

**Decision: proceed to a real H1 re-benchmark against this transport.** All
six of the ADR's own pre-committed pass criteria were met on the live smoke
run. See "Final verdict" below for exactly what this does — and does not —
authorize.

## 1. Why this ticket exists

`docs/decisions/h1-parity-signoff-lia433.md` recorded H1's final verdict:
**NO-GO** on flipping `deus-native` to default, because the A7 tool-loop
benchmark's Claude leg was persistently blocked by a `429 rate_limit_error`
from Anthropic on the very first call — both on 2026-07-14 and again on
2026-07-18 — using the current production transport,
`buildProxyRoutedChatAnthropic` (raw HTTP via `@langchain/anthropic`, routed
through the credential proxy).

That 429 is an account/transport-level blocker, not evidence that the
tool-calling *mechanism* fails under `deus-native`. LIA-449 asks a narrower
question: does routing through the **native Claude CLI subprocess**
(the same `claude --print --input-format stream-json --output-format
stream-json` transport the CLI itself already uses, authenticated via the
installed CLI's own OAuth session rather than a proxied HTTP API key) avoid
the same rate-limit wall, while still round-tripping a real MCP tool call
correctly? If yes, A7 becomes re-runnable against a transport that isn't
already known-blocked, which is the prerequisite for H1 to ever produce a
GO verdict at all.

This ticket is a **walking skeleton**, not a production integration: it
proves the transport + MCP seam mechanism once, in isolation, with real
credentials, and stops there.

## 2. What was built

- `src/agent-runtimes/cli-subprocess/stream-json-protocol.ts` — pure NDJSON
  framing (bounded partial-line buffer, non-empty malformed lines surfaced
  as `kind: 'malformed'`, never silently dropped) and narrowing helpers for
  `system/init`, `assistant`, `user`, and terminal `result` events. No
  subprocess. 22 unit tests.
- `src/agent-runtimes/cli-subprocess/claude-cli-session-pool.ts` —
  `ClaudeCliSessionPool`: Object Pool + Factory (the session type is not
  exported at all; every caller goes through the pool's `maxProcesses`
  accounting) + Observer (nine typed lifecycle events —
  `spawned`/`turn_started`/`turn_completed`/`concurrency_rejected`/
  `termination_requested`/`idle_reaped`/`unexpected_exit`/`exited`/
  `cleanup_complete` — through one `onEvent` callback per pool instance).
  Owns spawn, one-turn-at-a-time serialization, idle reap, crash/exit
  surfacing, the concurrency cap, and parent cleanup, reusing
  `killProcess`/`forceKillProcessGroup`/`processExists` from
  `src/platform.ts` rather than scattering raw signal logic. Also owns the
  addendum-2 tsx-loader-path fix (`resolveTsxLoaderPath`, via
  `createRequire(import.meta.url).resolve('tsx', { paths: [repoRoot] })`,
  verified against the installed `tsx` package's `"."` export ->
  `dist/loader.mjs`) and the ephemeral `--mcp-config` scratch-file builder.
  Also owns two fixes a gpt code-review co-gate caught in this same session
  (both independently re-verified — see "Review-caught fixes" below):
  a per-stream `StringDecoder` (`node:string_decoder`) replacing independent
  `chunk.toString('utf8')` calls on stdout/stderr, and an unconditional
  `await record.finalizedPromise` at the end of `terminateSession` so
  `shutdownAll()` cannot report `cleanup_complete` before the real child
  `exit` event has actually fired. 29 unit tests, all against an **injected
  fake spawn function and fake process-control primitives** — no real
  `claude` binary in this suite.
- `src/agent-runtimes/cli-subprocess/permission-check-mcp-server.ts` — a
  standalone stdio MCP entrypoint exposing exactly one tool,
  `check_permission(toolName, probeId)`, reusing the existing pure
  `evaluatePermission`/`resolvePermissionProfile` from
  `src/agent-runtimes/permission-rules.ts` (the real `read-only` profile,
  not a synthetic echo tool). The handler is exported and directly callable
  without spawning anything. 6 unit tests.
- `scripts/spikes/lia449_cli_subprocess_mcp_walking_skeleton.ts` — the
  credentialed smoke runner (see §3/§4), following the executable-spike /
  live-evidence pattern `lia400_tool_loop_reliability_benchmark.ts` already
  established for this repo, rather than a CI-run `*.integration.test.ts`.
  Also owns a third review-caught fix: the rate-limit fallback text scan
  previously ran `\b429\b` against the ENTIRE `JSON.stringify`d event
  history, so any ordinary numeric field that happened to equal 429 (a
  token count, a duration, ...) could false-positive a clean run as
  rate-limited. Narrowed to scan `stderrTail` only — genuine raw diagnostic
  text, not structured data with arbitrary numeric fields — while the
  structural `rate_limit_event.rate_limit_info.status` check (unaffected by
  this bug) remains the primary signal.

**Review-caught fixes (this session, gpt code-review co-gate, 3 rounds):**
all three were genuine, independently re-verified — not deferred as
"informational" — before this ADR's evidence was finalized:
1. UTF-8 chunk-splitting: proved via a real red-green test (a 4-byte emoji
   split byte-for-byte across two raw `Buffer` chunks fails with `�`
   corruption on the old `toString('utf8')`-per-chunk code, passes with the
   `StringDecoder` fix).
2. Async-exit-await gap: proved via a real red-green test (a fake
   `forceKill` that schedules its exit asynchronously instead of firing it
   synchronously — the shape every existing fake in this suite used, which
   is exactly why this gap survived two earlier review rounds — shows
   `shutdownAll()`'s promise settling before the process is actually
   confirmed dead on the old code, and correctly waiting on the fixed code).
3. Rate-limit scan false-positive class: fixed by construction (narrowing
   the scan surface); re-verified by re-running the live credentialed smoke
   test end-to-end against the corrected code (see §3 for the fresh result).

**Verification (this session, all green, re-run after all three fixes):**

```
npx vitest run src/agent-runtimes/cli-subprocess   # 3 files, 57/57 passing
npm run typecheck                                   # tsc --noEmit, 0 errors
npm run lint                                         # 0 errors (0 from new files)
```

`npm run build`'s full chain does not reach the point of type-checking
these new files this session: the script's `for d in packages/*/; do tsc -p
"$d"; done` loop fails on several pre-existing, unrelated sub-packages
(`packages/tui`, `packages/mcp-discord`, `packages/mcp-gmail`,
`packages/mcp-slack`, `packages/mcp-teams`, `packages/mcp-telegram`,
`packages/mcp-whatsapp`, `packages/mcp-x`, ...) whose own `node_modules`
aren't installed in this workspace snapshot, which short-circuits the `&&`
chain before it reaches the main `tsc` step. Verified this is pre-existing
and unrelated to this change, not a regression: (1) the build error output
contains zero references to `cli-subprocess` or `lia449`; (2) the identical
class of failure reproduces on an unrelated, unmodified checkout of this
repo's `main` branch; (3) `npm run typecheck` (the root `tsc --noEmit`
invocation that *would* catch a type error in these new files) passes with
zero errors.

## 3. The live smoke run (real credentials, real CLI, real MCP round-trip)

Run 2026-07-18, `npx tsx
scripts/spikes/lia449_cli_subprocess_mcp_walking_skeleton.ts`, against the
installed `claude` CLI **2.1.214**, authenticated via **claude.ai OAuth**
(`apiProvider: firstParty`, `subscriptionType: max` — confirmed via `claude
auth status --json`, non-secret fields only; no email/org id/credentials
read into this doc or the results artifact).

**Result: 17/17 assertions PASS.** Full artifact:
`scripts/spikes/lia449_cli_subprocess_mcp_walking_skeleton.results.json`
(committed alongside this ADR; redacted per the base plan's rules — no
credentials, no account identity, no absolute credential paths, no raw
prompts, no machine-specific PIDs).

| Phase | Assertion | Result |
|---|---|---|
| 3 | conversation B rejected while A is alive (capacity) | PASS |
| 3 | `concurrency_rejected` lifecycle event emitted | PASS |
| 5 | `system/init` reports `deus_lia449` MCP server connected | PASS |
| 5 | assistant calls exactly one `mcp__deus_lia449__check_permission` | PASS |
| 5 | its input carries the generated `probeId` + `toolName: "write_file"` | PASS |
| 5 | the tool-result event carries the same `probeId`, `deny`, `rule` | PASS |
| 5 | terminal result is successful (`is_error: false`, `subtype: "success"`) | PASS |
| 5 | terminal result text reflects the tool outcome (`"ok"`) | PASS |
| 5 | CLI process PID unchanged across the whole turn | PASS |
| 5 | zero 429 / rate-limit-error evidence in events or stderr | PASS |
| 6 | external force-kill -> `unexpected_exit` classified/surfaced | PASS |
| 6 | `exited` lifecycle event observed after the force-kill | PASS |
| 6 | CLI process confirmed gone (`processExists` false) | PASS |
| 6 | MCP server child process confirmed gone (`processExists` false) | PASS |
| 7 | idle-only conversation: `idle_reaped` emitted | PASS |
| 7 | idle-only conversation: `exited` emitted | PASS |
| 7 | idle-only conversation's process confirmed gone | PASS |

Timings (final re-run, after all three review-caught fixes above): spawn
~3ms, the one real turn (including the live MCP round-trip) ~9.6s, full
8-phase run ~14.5s.

**One genuine finding during this run, corrected before the pass above:** a
naive `/429|rate_limit_error/i` substring scan of the collected events
false-positived on this run's own random session UUID (a coincidental hex
fragment, `...9e91-`**`429e`**`-b0cd...`, not an HTTP 429) — caught by
inspecting the actual matched substring rather than accepting the boolean
result at face value. Fixed with a word-bounded pattern (`\b429\b`, which
requires a non-word boundary on both sides and correctly rejects `429e`)
plus a structural check on the CLI's own `rate_limit_event.rate_limit_info
.status` field as the primary signal. Documented here because it is exactly
the kind of "verified but wrong inference" failure mode this repo's own
verification rules warn about — the first (unfixed) run's boolean `FAIL`
was accurate as a signal that something matched, but the naive conclusion
("this proves a real rate limit") would have been wrong without reading the
actual matched text.

## 4. Isolation (verified via `git diff --name-only`)

Only new files were added this session:

```
src/agent-runtimes/cli-subprocess/stream-json-protocol.ts (+test)
src/agent-runtimes/cli-subprocess/claude-cli-session-pool.ts (+test)
src/agent-runtimes/cli-subprocess/permission-check-mcp-server.ts (+test)
scripts/spikes/lia449_cli_subprocess_mcp_walking_skeleton.ts (+.results.json)
docs/decisions/deus-native-cli-subprocess-mcp-seam.md (this file) + INDEX.md entry
```

No barrel/`index.ts` was added for `cli-subprocess/`. Nothing in
`deus-native-model.ts`, `deus-native-backend.ts`, `nested-dispatch.ts`,
`nested-dispatch-tool.ts`, the runtime registry
(`registry.ts`/`production-registry.ts`), `src/agent-runtimes/index.ts`, or
anything reachable from `DeusNativeRuntime.runTurn()` was touched — the
production raw-HTTP path (`buildProxyRoutedChatAnthropic`) remains
byte-for-byte unchanged. This is deliberate "build beside, not inside" —
the same Strangler-adjacent posture the deus-v2 migration already uses for
every walking skeleton (`docs/decisions/deus-v2-langchain-runtime.md`).

## 5. Final verdict

**Proceed to a real H1 re-benchmark against this transport** — the pre-
committed pass bar (OAuth confirmed, custom MCP round-trip, zero-429,
concurrency rejection, crash surfacing, idle reap, process-tree cleanup)
was met in full on live evidence, not simulated.

**This explicitly does NOT:**

- **Clear H1/LIA-433's NO-GO.** That verdict stands. This only shows the
  *transport* is no longer a known-blocked dead end for re-testing — it
  says nothing yet about sustained/high-volume tool-loop reliability (the
  actual thing A7 measures), which still needs to be re-run against this
  transport before H1 can be revisited.
- **Authorize a default-backend flip.** `claude` remains the default
  backend for chat-turn dispatch; nothing here changes
  `backend-neutral-agent-runtime.md`'s parity matrix or H2/LIA-434's
  blocked status.
- **Unblock H2/LIA-434 by itself.** H2 remains blocked on a future H1 GO,
  which this ticket does not produce.
- **Authorize any production wiring.** No caller anywhere imports this
  module; it stays an isolated, unregistered spike per §4.

### Principal risks preserved (base plan's own list, still open)

- One successful OAuth turn disproves the *immediate* raw-HTTP blocker but
  says nothing about sustained or high-volume rate-limit behavior — that is
  exactly what an A7 re-run against this transport would need to measure.
- Claude's stream-json wire format is an agent-*harness* protocol
  (system/init, tool_use, tool_result, terminal result — a full agent
  loop's own event stream), not a LangChain `BaseChatModel` protocol. A
  successful spike here may imply a larger runtime-ownership question
  ("does the CLI own the agent loop, or can it coexist with LangChain's
  loop?") rather than a drop-in "replace the model client."
- CLI event schemas and MCP tool naming may drift across Claude Code
  versions even when the documented flags remain stable.
- Prompting a model to call the sole allowlisted tool reduces
  nondeterminism (this run: 1/1) but does not eliminate it structurally.
- Parent cleanup (`shutdownAll`/`shutdownAllSync`) cannot run after a
  parent `SIGKILL`, kernel panic, or power loss. Production would still
  need startup-time orphan reconciliation or an OS-level supervisor —
  this walking skeleton only proves *cooperative* cleanup.
- The CLI could in principle detach its MCP child from its own process
  group; checking the MCP server's own PID is gone post-kill (phase 6,
  verified PASS) is an *acceptance assertion this run happened to confirm*,
  not a structural guarantee for every future CLI version.
- One stdio tool proving connectable says nothing about the security or
  parity implications of exposing Deus's full tool catalog this way.
- This avoids the npm `@anthropic-ai/claude-agent-sdk` billing-ambiguity
  question (LIA-433's own open question) by using the native CLI directly,
  but product/legal authorization for automated, subscription-backed CLI
  use in any production path remains a wholly separate, unaddressed policy
  question.

### Follow-ups required before H2 (none filed yet — filing waits on this ADR's acceptance, per the base plan)

1. Whether the Claude CLI owns the agent loop, or can coexist with
   LangChain's `createAgent` loop `deus-native` already uses.
2. Mapping Deus middleware — permission enforcement, context loading,
   checkpointing, transcript storage, model selection, usage accounting,
   cancellation, replay safety — onto this MCP seam. None of that exists
   yet; this skeleton proves only the transport + one tool.
3. Production-wide (not just in-process) concurrency and orphan control —
   this pool's cap and cleanup are process-local only.
4. A full tool-catalog exposure + security review (this skeleton exposes
   exactly one read-only-profile-gated tool, deliberately).
5. Cross-platform (this skeleton is POSIX-only by design — see the plan
   addendum) and multi-conversation load testing.
6. The explicitly excluded Codex/GPT equivalent transport.

## 6. Platform scope

POSIX (macOS/Linux) only, by deliberate design — the detached-process-group
spawn and its group-signal cleanup are POSIX semantics. This session's live
run was on macOS (Darwin). `src/platform.ts`'s existing `taskkill /T`
Windows branch is the known path for a future cross-platform pass; nothing
here required touching it.
