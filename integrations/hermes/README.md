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
- `requirements.txt` - documents the `mcp` version-compatibility assumption (see comments inline - not pip-installed separately).
- `skills/deus-memory/SKILL.md` - Option A's model-initiated recall/log convention.
- `tests/test_deus_memory_provider.py` - network-free pytest suite (monkeypatched MCP client).
- `ab_compare.py` (LIA-501) - A/B/n compares Hermes model **Profiles** (not
  `gateway.profile_routes`/`multiplex_profiles` - that's a live-gateway
  inbound-message routing mechanism, unrelated to this synchronous batch
  script) on a shared prompt/conversation, scored by Deus's own judge
  harness (`evolution.judge`). Drives `hermes -p <profile> chat -q ... -Q`
  as a subprocess per profile; does not create or configure profiles
  itself - see the script's own docstring for the one-time
  `hermes profile create` precondition and the memory-pollution warning
  (keep A/B profiles free of `memory.provider: deus`, or synthetic
  comparison runs get logged into the evolution store as real interactions).
- `tests/test_ab_compare.py` - network-free pytest suite (monkeypatched
  `subprocess.run` and judge resolution).

## Not covered by this pass

- **Privacy-label propagation into `memory_tree.db`** (pre-existing gap, unaffected either way by this integration) - real schema/policy work on a database shared well beyond this integration (Claude Code hooks, other MCP clients, both the `~/deus` and `~/deus-v2-mvp` checkouts). Deliberately scoped as a separate effort with its own plan-review, not bundled here.
- Turn-to-interaction schema refinement (finer than the flat `"hermes"` group_folder) and loop-ownership policy documentation.
- Soak testing / parity benchmarking against the Claude Code hook experience.
- Docs + upstreaming decision.
- **Container isolation for live chat channels** (see Security model above) - required before this goes beyond a single-operator local session, even once separate Profiles are used for per-contact isolation.
