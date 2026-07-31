# Deus <-> Hermes integration

Connects Deus's memory/evolution layer to [Hermes Agent System](https://github.com/NousResearch/hermes-agent) (NousResearch), a third-party multi-platform AI agent framework. Gives Hermes conversations the same automatic per-turn recall + interaction logging that Claude Code already gets via its own hooks, and (independently) lets Hermes call `memory_recall`/`log_interaction` as ordinary MCP tools.

Two integration paths, both provided here, both can run at once:

- **Option A - MCP bridge**: register the existing `deus-memory` + `deus-evolution` MCP servers directly with Hermes (`scripts/deus-memory-mcp`, `python -m evolution.mcp_server` - see repo root). Model-initiated only: Hermes decides whether to call these tools, same as any other tool.
- **Option B - native provider** (`deus_memory_provider/`): a `MemoryProvider` plugin, automatic and silent - Hermes calls it before/after every turn with no model decision involved, the same shape as Claude Code's own `UserPromptSubmit` hook.

Verified this session against live `NousResearch/hermes-agent` source (repo legitimacy, per-conversation identity scoping, out-of-tree plugin loading, host-trust topology, `background_review`'s structural exclusion of external providers) before building either path. Full research trail: see the session's saved research file.

## Security model

- **Deus's stores stay append/read-only from Hermes's side.** `memory_recall` reads, `log_interaction_tool` appends. Nothing here ever mutates the vault, atoms, or reflections stores.
- **Never a direct import.** `deus_memory_provider/` runs inside Hermes's own Python process but only ever speaks MCP protocol to the two Deus servers, each spawned as its own subprocess with its own separately-pinned environment (`evolution/requirements.txt`, unchanged). No Deus dependency (`google-genai`, `sqlite-vec`, `sentence-transformers`, ...) needs to exist inside Hermes's env.
- **`memory_recall` is full-vault, uncurated recall** (its own module docstring calls it "the broad external recall surface" - no privacy-label filtering exists yet on the memory-tree layer; this is a pre-existing condition of the memory layer, not something this integration introduces). A prompt-injectable third-party agent can, in principle, surface and exfiltrate anything reachable through it - see `integrations/odysseus/README.md` for the same concern handled via a curated `Shareable/` subset. That curation is **not** done here (real schema/policy work, out of scope for this pass) - the mitigating control used instead, for this pass:
- **This validation pass runs single-conversation, local CLI only - no live chat channels connected**, and the Hermes session config explicitly sets `disabled_toolsets` to exclude any web-search/browse-shaped toolset, so no externally-fetched content can reach the same context as the recall tool during this pass. This is a deliberate, named control - not an assumption that Hermes's default toolset happens to be safe.
- **Before ever connecting additional contacts/channels** to a Hermes install running this provider - **correction to an earlier claim in this file**: a prior version of this note said `enabled_toolsets` could be scoped "per-user" to isolate individual contacts. That overstated what Hermes actually supports - confirmed by reading `hermes_cli/tools_config.py::_get_platform_tools()` directly: `platform_toolsets` resolves by **platform** (`cli`, `telegram`, `discord`, ...), not by individual contact within a platform. There is no per-contact toolset filter for a single shared bot.
  1. **The real mechanism for per-contact isolation is Hermes's own Profiles system** (`hermes profile create <name>`, each with its own `HERMES_HOME`, bot tokens, sessions, and memory - see `hermes-agent`'s own `website/docs/user-guide/profiles.md`). To give only the operator's own identity access to `memory.provider: deus` and the `mcp-deus-*` toolsets, run the operator's own bot/channel as its own profile with this provider configured, and any other contacts on a **separate profile** that does not configure `memory.provider: deus` and does not register the `deus-memory`/`deus-evolution` MCP servers at all.
  2. **A single shared bot token does not require separate bots either** - correction to an earlier draft of this note, which said it did. Verified directly against `gateway/profile_routing.py` and `website/docs/user-guide/multi-profile-gateways.md` ("Routing shared-bot chats to profiles"): with `gateway.multiplex_profiles: true`, `gateway.profile_routes` routes by `platform + chat_id` (`+ thread_id`/`guild_id`) to a **different profile per route**, on one bot token - "works on every platform adapter, not just Discord," including a worked Telegram example keyed on `chat_id` alone. The routed profile gets full isolation (config, skills, memory, credentials, session namespace). For DM-style platforms this gives genuine per-individual isolation (each contact's `chat_id` routes independently); for group/channel platforms it's per-group/channel (everyone inside one shared group chat still shares that group's routed profile - it doesn't distinguish individual senders within one group). Concretely: route the operator's own `chat_id` to a profile with `memory.provider: deus` configured, and route every other contact's `chat_id` to a profile without it.
  3. This also crosses from "trusted local driver" into "untrusted channel input" per this repo's own `docs/EDITOR_INTEGRATION.md` trust-boundary framing, which calls for container isolation that this pass does not set up - true regardless of the profile-vs-toolset distinction above.
- **`group_folder="hermes"`** - a deliberate, explicit value for every interaction this provider logs (`log_interaction_tool`'s `group_folder` is a required field with no default). Confirmed no existing channel in `groups/` uses this name. Finer-grained isolation (e.g. `hermes/<session_id>`) is a reasonable follow-up, not done here.
- `sync_turn()` skips logging entirely when `agent_context != "primary"` (Hermes passes `"subagent"`/`"cron"`/`"flush"` for non-primary contexts) - a cron run or a delegated subagent turn never gets logged into Deus's evolution store as if it were a real user interaction.

## Setup

1. Ensure this repo's own Python environment has `evolution/requirements.txt` installed (needed for the two MCP server subprocesses this provider and Option A both depend on).
2. Register the MCP servers with Hermes (command-list form, not the shell launcher, for portability). Point at this repo's own venv interpreter explicitly, not bare `python3` - confirmed this session that an unqualified `python3` can resolve to a system interpreter lacking the `mcp` package entirely, breaking the subprocess handshake with no clear error:
   ```
   deus-memory:    <repo>/.venv/bin/python3 <repo>/scripts/memory_mcp_server.py
   deus-evolution: <repo>/.venv/bin/python3 -m evolution.mcp_server   (cwd: <repo>, env PYTHONPATH=<repo>)
   ```
   Do not invoke `scripts/deus-memory-mcp` via `python3` - it's a POSIX shell script (`#!/usr/bin/env sh`), not Python source; running it that way is a syntax error.
3. Symlink the native provider and skill into Hermes's own directories:
   ```bash
   ln -s "<repo>/integrations/hermes/deus_memory_provider" "$HERMES_HOME/plugins/deus"
   ln -s "<repo>/integrations/hermes/skills/deus-memory" "$HERMES_HOME/skills/memory/deus-memory"
   ```
4. In Hermes's `config.yaml`, set `memory.provider: deus`, and for this validation pass set `disabled_toolsets` to exclude any web-search/browse toolset (see Security model above).

## Teardown / rollback

```bash
rm "$HERMES_HOME/plugins/deus"
rm "$HERMES_HOME/skills/memory/deus-memory"
# In Hermes's config.yaml: unset memory.provider, remove the deus-memory /
# deus-evolution entries under mcp_servers.
```

## File manifest

- `deus_memory_provider/__init__.py` - the `MemoryProvider` adapter (Option B).
- `deus_memory_provider/mcp_client.py` - the MCP-client helper it wraps.
- `_stub_memory_provider_abc.py` - shared stub for Hermes's `agent.memory_provider.MemoryProvider` ABC, used by both `tests/test_deus_memory_provider.py` and `check_memory_reconciliation.py` so the adapter is importable standalone outside a real Hermes install.
- `check_memory_reconciliation.py` - reconciliation check between a real write through the adapter and a direct read-back from `evolution.db` (LIA-499). See "Memory write/read reconciliation" below.
- `requirements.txt` - documents the `mcp` version-compatibility assumption (see comments inline - not pip-installed separately).
- `skills/deus-memory/SKILL.md` - Option A's model-initiated recall/log convention.
- `tests/test_deus_memory_provider.py` - network-free pytest suite (monkeypatched MCP client).
- `tests/test_check_memory_reconciliation.py` - network-free pytest suite for `check_memory_reconciliation.py`'s own pass/fail logic (monkeypatched write and read sides).

## Memory write/read reconciliation

`check_memory_reconciliation.py` writes one real interaction through the actual `DeusMemoryProvider` adapter lifecycle (`sync_turn()` immediately followed by `shutdown()` - deliberately reproducing the exact real-world shape of PR #79's shutdown-drop bug), then asserts it landed intact by reading it back.

**It reads back directly from `evolution.db`, not via `memory_recall`.** This is a deliberate deviation from the more obvious-sounding "write it, then recall it" shape, found while grounding the plan in the actual code: `memory_recall` reads `memory.db` (vault-derived, indexed from `Session-Logs/*.md` by `scripts/memory_indexer.py`), while `log_interaction_tool` (what `sync_turn()` calls) writes `evolution.db` - two deliberately separate files with **no cross-database joins** (see `docs/decisions/evolution-db-split.md`; `memory_tree.py` actively aborts if it ever sees evolution tables mixed into `memory.db`). There is no code path, eventual or lagged, that makes a freshly-logged interaction visible to `memory_recall` - a check built against that surface would report drift on every single run since inception regardless of whether anything is broken, and it would not have caught PR #79's actual bug either (a row never reaching `evolution.db` at all, unrelated to vault/semantic-recall visibility). The MCP surface exposes no read tool for interactions (only `log_interaction_tool`, `get_reflections_tool`, and friends are registered in `evolution/mcp_server.py`), so the check imports `evolution.ilog.interaction_log` directly, in-process - the closest available thing to a "provider read" for this data. **If you're tempted to "fix" this back to using `memory_recall`, re-read this paragraph first** - it isn't an oversight.

**Contamination guard - `diagnostic=True`.** An ai-eng review of the first pass at this check (LIA-499) found that its synthetic tagged text (`"[reconciliation check <uuid>] prompt"`), written through the real `sync_turn()` -> `log_interaction_tool` path, would unconditionally trigger the real judge-eval + reflection-generation step (`_async_judge_and_reflect` in `evolution/mcp_server.py`) - and since that placeholder text has no real assistant reasoning, it would very likely score below `REFLECTION_THRESHOLD` (default `0.6`, `evolution/config.py`) and get a nonsense "lesson" written into the real, shared reflections store under `group_folder="hermes"` - the same store real future Hermes conversations retrieve from via `get_reflections_tool`. Fixed by threading a `diagnostic` flag from `check_memory_reconciliation.py`'s `sync_turn(..., diagnostic=True)` call through `_sync_turn_call()` to `log_interaction_tool`'s own `diagnostic` param (see that tool's docstring): when set, the interaction row is still written and read back exactly as before, but the judge call and reflection generation are skipped entirely - no LLM call happens at all for this check anymore, and the real reflections store can never be contaminated by it. `diagnostic` is not part of Hermes's `MemoryProvider` ABC and defaults to `False`; Hermes itself never passes it, so this is invisible to real production interactions.

Where this runs: **manual/on-demand, not wired into CI or a cron in this pass.** Every run still spawns real subprocesses and needs live credentials/config the same way the rest of this integration does - not the "embedding-free" shape of `scripts/memory_health.py`'s session-start probes - but (per the contamination guard above) costs zero LLM calls and writes nothing to the reflections store. Highest value is right after touching the write path this integration cares about (`deus_memory_provider/__init__.py`, `mcp_client.py`, `evolution/mcp_server.py`, `evolution/ilog/interaction_log.py`, `evolution/storage/**`). A daily cron/launchd job (following the `scripts/evolution_backup.py` precedent) is a reasonable follow-up, deliberately deferred - see "Not covered by this pass" below.

Run it directly: `python3 integrations/hermes/check_memory_reconciliation.py` (exit `0` reconciled, `1` a real omission/drift finding, `2` an environment/usage error - kept distinguishable on purpose, mirroring `scripts/ci/wait_for_checks.py`'s convention).

## Not covered by this pass

- **Privacy-label propagation into `memory_tree.db`** (pre-existing gap, unaffected either way by this integration) - real schema/policy work on a database shared well beyond this integration (Claude Code hooks, other MCP clients, both the `~/deus` and `~/deus-v2-mvp` checkouts). Deliberately scoped as a separate effort with its own plan-review, not bundled here.
- Turn-to-interaction schema refinement (finer than the flat `"hermes"` group_folder) and loop-ownership policy documentation.
- Soak testing / parity benchmarking against the Claude Code hook experience.
- Docs + upstreaming decision.
- **Container isolation for live chat channels** (see Security model above) - required before this goes beyond a single-operator local session, even once separate Profiles are used for per-contact isolation.
- **Reconciliation check scheduling** (CI wiring or a periodic cron for `check_memory_reconciliation.py`) - see "Memory write/read reconciliation" above for why this pass keeps it manual-only.
- A secondary "`prefetch()` does not leak the reconciliation tag" isolation assertion was considered for `check_memory_reconciliation.py` (a cheap regression guard that the two stores stay separated as designed) but deferred as a separable follow-up rather than bundled into this pass's core write/read-back signal, which tests a different property (reconciliation, not isolation).
