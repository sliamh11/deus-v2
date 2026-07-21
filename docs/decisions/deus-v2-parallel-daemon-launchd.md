# Deus v2: Parallel launchd Daemon — Canonical Service Mechanism & Phase 1 Scope (LIA-453 Scope A)

**Status:** Accepted
**Date:** 2026-07-21
**Scope:** `setup/service.ts` (`setupLaunchd()`/`setupLogReviewLaunchd()`),
`docs/SPEC.md`'s Deployment section, `launchd/` (removed — see below),
`~/bin/deus-v2` (host-local, not in this repo)
**Related:** none yet — first ADR covering v2's own daemon lifecycle.
`deus-v2-langchain-runtime.md` covers the in-process agent runtime this
daemon hosts, not the daemon/service layer itself.

## Context

v1 (`~/deus`) runs live today as a full daemon — channels, webhooks,
scheduled jobs, the works. v2 (`~/deus-v2-mvp`) has so far only shipped as an
interactive CLI client (Scope B/LIA-452): no persistent daemon, no channel
traffic, no scheduled jobs beyond the ones already namespaced under
`com.deus-v2.*`. LIA-453 Scope A gives v2 the other half v1 has — a real
standing daemon, side-by-side with v1 on the same host, so v2 can be
exercised under real conditions (real scheduled jobs, a real webhook
surface) instead of only manual chats.

**Confirmed live state at the time this decision was made:**

- v1 `com.deus`: PID 44479, listening 3001/3003.
- v2 was running via the personal nohup launcher (`~/bin/deus-v2`, a
  host-local script, not part of this repo): PID 27079, bound to 3101/3103.
- `~/Library/LaunchAgents/com.deus-v2*` did not exist yet —
  `setup/service.ts`'s launchd installer had real, tested code but had never
  actually been run on this host.
- llama-cpp (PID 963, `:8080`) was already v2's configured default client
  target — zero code change needed there.

## Decision

### 1. launchd is the canonical service mechanism for deus-v2, superseding the nohup launcher

`~/bin/deus-v2` (the personal nohup launcher used to start/stop/status v2
during Scope B) is retired for daemon lifecycle. Going forward, `com.deus-v2`
is a real `launchd` job — installed and started via
`npm run setup -- --step service`, which calls `setupLaunchd()`
(`setup/service.ts`) and writes `~/Library/LaunchAgents/com.deus-v2.plist`
directly (no checked-in plist template; see `docs/SPEC.md`'s Deployment
section for the generated shape and the managing-the-service commands).
`deus-cmd.sh` already assumed launchd was canonical
(`PLIST=~/Library/LaunchAgents/com.deus-v2.plist`) before this rollout, so
this decision brings the actual running instance into line with what the
repo's own tooling already expected, rather than introducing a new
assumption.

Rationale: `KeepAlive=true` gives crash-restart and boot-persistence nohup
does not; a single `launchctl` surface (`launchctl list | grep com.deus-v2`)
replaces a bespoke script as the source of truth for whether the daemon is
up; and it matches v1's own precedent (`com.deus` is itself a launchd job).

### 2. Per-job disposition (v1's ~12 real launchd jobs, decided with the user)

Verified via `ls ~/Library/LaunchAgents/com.deus.*.plist` plus reading each
plist's actual `ProgramArguments` — not just grepping the codebase, since
several of v1's jobs are host-local scripts outside either repo and would be
missed by a code-only search.

| Job | Disposition |
|---|---|
| main daemon, credential-proxy, tool-proxy, Odysseus HTTP, ingress-gateway, ngrok | **Build (Phase 1)** — already coded+namespaced in v2, just gated off by env flags |
| maintenance, morning-report, evolution-backup | **Already done** (LIA-451/452 + a prior session's PR) |
| log-review | **Already coded + namespaced correctly** (`com.deus-v2.log-review`, own `~/.deus-v2` state) but never yet installed on this host — Phase 1's rollout installs it for the first time; included in Phase 1's before/after verification and rollback list |
| healthcheck, log-to-issue | **Build (Phase 2)** — v2-scoped equivalents, in-repo (deviates from v1's out-of-repo scripts, following v2's own established `SCHEDULED_JOBS` convention) |
| llama-cpp | **Share v1's `:8080`** — no new job, confirmed already wired correctly |
| oauth-refresh, backup (vault rsync), gcal-keepalive | **Excluded — share v1's**, same race-risk reasoning as the already-excluded oauth-refresh (shared credentials/shared vault, a second instance only adds collision risk) |
| check305 | **Excluded** — confirmed (read the script) it's a one-off idempotent diagnostic for an already-tracked v1 GitHub issue, not a generic template |
| milvus | **Excluded** — confirmed via grep, zero references in either repo's actual memory/embedding pipeline (which uses Ollama embeddinggemma + SQLite); unrelated legacy infra |

Phase 1's rollout therefore installs five `com.deus-v2*` launchd labels, not
one: `com.deus-v2`, `com.deus-v2.log-review`, `com.deus-v2.maintenance`,
`com.deus-v2.morning-report`, `com.deus-v2.evolution-backup`. Phase 2 adds
two more (`com.deus-v2.healthcheck`, `com.deus-v2.log-to-issue`), bringing
the total to seven.

### 3. Channels stay off — deliberate scope limit for Phase 1

Phase 1 enables credential-proxy, tool-proxy, Odysseus HTTP, ingress-gateway,
and ngrok. It deliberately does **not** enable any channel (WhatsApp,
Telegram, Slack, Discord, Gmail). The exact reasoning, carried forward
verbatim from the plan's own risk analysis:

> **Open risk, explicitly flagged, not silently resolved:** enabling the
> ingress gateway does NOT currently risk double-handling real
> WhatsApp/Telegram/Slack messages — those channels gate independently on
> credentials v2 doesn't have. The real risk is operational: if `.env` is
> ever carelessly populated with v1's live bot tokens or v1's WhatsApp
> session is copied into v2's `store/auth`, two daemons would both try to
> handle the same live messages. The decision doc must say explicitly:
> channels stay off until a separate, deliberate decision; any future
> activation uses v2's own bot/session, never v1's.

Concretely: `setup/service.ts`'s plist generation adds
`ODYSSEUS_HTTP_ENABLED=1`, `INGRESS_GATEWAY_ENABLED=1`,
`INGRESS_TUNNEL_ENABLED=1` to `EnvironmentVariables`, and explicitly does
**not** add any channel bot-token env var. This is pinned by an
independently authored (`oracle-author`, blind to the implementation)
`@oracle`-tagged test in `setup/service.test.ts` asserting the three new
flags are present and that no channel-token key is ever emitted — the actual
safety net for this guarantee on a live-host change, not merely an
implementation self-check.

Any future decision to turn a channel on for v2 is separate and deliberate,
and must use v2's own bot/session — never v1's live tokens or v1's WhatsApp
`store/auth` session.

### 4. llama-cpp sharing — no new job

v2 does not run its own llama-cpp instance. `src/config.ts` already defaults
`LLAMA_CPP_PORT=8080` and `container-runner.ts` already wires containers to
point at v1's already-running llama-cpp instance (PID 963 at the time this
was written). This is a deliberate non-duplication, not an oversight:
verification is `lsof -iTCP:8080` showing exactly one `llama-server` process
throughout, both before and after v2's daemon rollout.

## Consequences

**Positive:**

- One canonical way to start/stop/inspect v2's daemon (`launchctl`), matching
  `deus-cmd.sh`'s pre-existing assumption and v1's own precedent.
- `KeepAlive=true` gives crash-restart and boot-persistence the nohup
  launcher never had.
- v1 and v2 can run side-by-side on the same host with zero port/credential
  collision, verified before/after via `launchctl list`/`lsof`.

**Negative / residual risk:**

- The main daemon (`KeepAlive=true`) and the scheduled jobs
  (`RunAtLoad=false`, no `KeepAlive`) do not share a shutdown mechanism —
  the main daemon needs `launchctl bootout`, a bare `unload` just gets
  respawned; each scheduled job's plist needs its own `unload`. Documented
  explicitly in `docs/SPEC.md`'s Deployment section and in the rollback
  procedure this ADR's rollout followed.
- `~/bin/deus-v2` retiring for daemon lifecycle is a host-local change
  outside this repo's version control — it is recorded here so the reasoning
  survives even though the script itself isn't tracked.

## Non-Goals

- Does not enable any channel — see §3 above.
- Does not run a second llama-cpp instance — see §4 above.
- Does not touch v1's `com.deus` daemon, its scheduled jobs, or its ports in
  any way.

## References

- LIA-453 (this ticket, Scope A)
- `docs/SPEC.md` — Deployment section (generated plist shape, managing-the-service commands)
- `setup/service.ts` — `setupLaunchd()`, `setupLogReviewLaunchd()`, `SCHEDULED_JOBS`
