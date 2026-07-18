# Backend-Neutral Agent Runtime

**Status:** Accepted
**Date:** 2026-04-23
**Scope:** `src/agent-runtimes/`, `container/agent-runner/`, `deus-cmd.sh`, `deus-cmd.ps1`, `AGENTS.md`, `AI_AGENT_GUIDELINES.md`

## Context

Deus began as a harness around Claude Code. That kept the first version small and powerful, but it made the core assistant runtime depend on Claude-specific sessions, tools, credentials, and prompt loading. The product goal has changed: the user should be able to switch interface/backend tools while everything around Deus stays the same — memory, tone, personal context, chat commands, vault rules, scheduled tasks, and channel behavior.

## Decision

Deus owns the runtime contract, session routing, credential boundary, and canonical tool plane. Claude is the default and compatibility baseline, but it is one backend adapter rather than the architecture itself. OpenAI/Codex is the first additional adapter.

Backend selection resolves in this order:

1. Scheduled-task override
2. Group override
3. Global `DEUS_AGENT_BACKEND`
4. Fallback to `claude`

Backend adapters must not read raw host secrets. They receive placeholder credentials and route through the credential proxy. Provider-native tools may be used later as accelerators, but Deus-owned tools and IPC remain the product contract.

Context and rules are provider-neutral. Adapters must load the same Deus memory/rule surfaces through a registry-style mechanism, including current `CLAUDE.md` files, future neutral names such as `AGENTS.md`, and `AI_AGENT_GUIDELINES.md` when present, so a naming migration is localized rather than spread through each backend.

Current implementation scope is intentionally phased: this change lands the backend-aware session/config/auth/context contracts and an opt-in OpenAI/Codex adapter foundation. Full OpenAI Agents SDK sessions, handoffs, and tracing remain parity work before OpenAI becomes a default backend.

## Alternatives Considered

- Keep Claude-specific runtime logic and add OpenAI beside it. Rejected because memory, scheduling, IPC, and tool semantics would drift across duplicated runners.
- Rename the vault and root instruction files away from Claude conventions immediately. Rejected because `CLAUDE.md` remains part of the live Claude Code compatibility contract during the migration.
- Rely on provider-hosted tools for OpenAI parity. Rejected because Deus-owned tools are the stable product surface; provider-native tools can be accelerators later, not the source of truth.
- Introduce a generic runtime contract and migrate Claude through the same contract. Chosen because it preserves current behavior while moving provider lock-in into adapters instead of product architecture.

## Consequences

- Claude remains the safest default path and must not regress.
- New backends are allowed only behind explicit selection until parity is verified.
- Sessions are backend-scoped. A stored Claude session must not be resumed by OpenAI/Codex, and vice versa.
- User experience parity is mandatory: memory, tone, commands, vault context, and scheduler behavior should feel like the same Deus through a different interface.
- This supersedes the older “Claude SDK lock-in” limitation. Any docs that still describe the core agent as permanently Claude-only are stale.

## Verification

Every backend adapter change should include or update a parity matrix covering:

- Session start/resume and backend mismatch behavior
- Filesystem, shell, web, browser, and Deus IPC tools
- Scheduled tasks and task-specific backend overrides
- Group/global/project/vault context loading
- Slash commands and user-visible command behavior
- Credential proxy routing and missing-secret failures

At minimum, run TypeScript checks plus targeted backend/session/auth/container tests before merging. Full live verification requires a rebuilt agent container and provider credentials.

## Parity Matrix

| Surface | Claude Default | OpenAI/Codex Opt-In | Llama.cpp Local Opt-In |
|---|---|---|---|
| Selection | Fallback/default backend | `DEUS_AGENT_BACKEND=openai`, group override, or task override | `DEUS_AGENT_BACKEND=llama-cpp`, group override, or task override |
| Global CLI `--print-identity` | Prints the identity/vault `--append-system-prompt` payload (assembly is backend-independent) | Same payload, same flag | Same payload, same flag (`deus-cmd.sh` only; ps1 parity tracked as AAG-013) |
| Sessions | Existing Claude session ids wrapped as backend refs | Responses id stored as an OpenAI backend ref | Client-side messages array (no server-side response state); synthetic session id |
| Backend mismatch | Starts fresh instead of resuming wrong backend | Starts fresh instead of resuming wrong backend | Starts fresh instead of resuming wrong backend |
| Credentials | Placeholder Anthropic credentials via proxy | Placeholder OpenAI credentials via `/openai` proxy route | Placeholder `LLAMA_CPP_API_KEY` injected; no proxy hop (llama-server has no auth) |
| Context files | Native Claude loading plus registry-managed non-native surfaces | Registry-managed `CLAUDE.md`, `AGENTS.md`, `AI_AGENT_GUIDELINES.md`, and `MEMORY_TREE.md` surfaces | Same as OpenAI — registry-managed surfaces |
| Tools | Existing Claude/MCP tool path | Container ToolBroker-backed function tools | Container ToolBroker-backed function tools (same path as OpenAI; reuses MCP bridge) |
| Scheduling | Existing IPC task tools | Same IPC task file contract with optional backend override | Same IPC task file contract with optional backend override |
| Global CLI | `deus` / `deus claude` | `deus codex`, `deus openai`, or `DEUS_CLI_AGENT=codex deus` | `deus backend set llama-cpp` (foreground `deus llama` shorthand is a follow-up) |

## Deus-Native Opt-In Readiness Matrix

| Surface | Status | Detail |
|---|---|---|
| Shell | Known Gap | `bash_exec` has no host-side sandbox boundary; the container-isolation assumption does not hold in-process. Deferred pending isolation review (`deus-native-backend.ts` `DEUS_NATIVE_CAPABILITIES.shell = false`). |
| Filesystem | Known Gap | `resolveWorkspacePath`'s `/workspace/*` allowlist is a container boundary, not a host boundary. Deferred with shell pending isolation review (`filesystem = false`). |
| Web | Verified Pass | `web_search`/host-allowlisted `web_fetch` are wired (`web = true`) — the only Deus-native tool-broker tools currently enabled (`buildSafeTools`). The model's tool list also includes `dispatch_nested_agent`, a separate non-broker primitive — see the "Nested agent dispatch" row below. |
| Multimodal | Known Gap | No image-input handling in `runTurn` (`multimodal = false`). |
| Handoffs | Known Gap | Missing across every backend today, not Deus-native-specific (`handoffs = false`). |
| Persistent sessions | Verified Pass | LangGraph `SqliteSaver` checkpointer keyed by `RuntimeSession.session_id` as `thread_id` (B4/LIA-404, `persistent_sessions = true`), covered by `deus-native-checkpointer-integration.test.ts`. |
| Tool streaming | Known Gap | `runTurn` returns one buffered result, no incremental deltas (`tool_streaming = false`). |
| Group-level backend opt-in | Verified Pass | `/settings backend=deus-native` + resolver behavior covered by this PR's new automated tests; not yet exercised in a live deployment. A backend-value change also closes any active warm container for that group (`queue.closeStdin`) so the very next message doesn't get piped into a stale process on the old backend — scoped precisely to backend changes, not other `/settings` keys. |
| Public-ingress interaction | Verified Pass | Enforced solely by the two pre-existing runtime guards in `container-runner.ts` and `deus-native-backend.ts`. `/settings` cannot reach a `publicIngress` group in the first place — webhook events never route through `dispatchHostCommand` (`message-orchestrator.ts:328-330`, `:833-839`) — so this PR adds no settings-layer check for it (would be unreachable dead code). |
| Backend-selection diagnostic visibility | Verified Pass | `RuntimeSession.backend` metadata, the existing `/context` command, and this PR's new per-run debug log. |
| Scheduled-task-level Deus-native override | Release Blocker (H1/LIA-433) | Resolution path is generic/shared with other backends and covered at the resolver-unit level, but confirmed via `grep -n "backend" src/task-scheduler.test.ts` (H1/LIA-433, 2026-07-18) that the suite only ever exercises `backend: 'claude'`/`backend: 'openai'` — no test runs a `deus-native` scheduled task end-to-end through `task-scheduler.ts`. Genuine, unresolved coverage gap, not just "not exercised by this PR." |
| Nested agent dispatch (`dispatch_nested_agent`) | Verified Pass | Wired into every Deus-native turn's tool list (`deus-native-backend.ts`: `tools = [...buildSafeTools(...), dispatchTool]`). In-process, one-shot nested `createAgent` dispatch (B8/LIA-408), covered by `nested-dispatch.test.ts` and `nested-dispatch.oracle.test.ts`, per `docs/decisions/deus-v2-subagent-dispatch.md`. Pre-existing, unrelated to and unmodified by this PR — listed here for completeness per AC3 ("each supported surface has an entry"). |
| Container-based multi-agent orchestrator (`src/multi-agent/orchestrator.ts`) | Verified Pass (H1/LIA-433) | Distinct mechanism from the row above (container-based `SubagentTask[]` scheduler vs. deus-native's in-process nested dispatch — AGENTS.md's own surface-map table keeps them as separate rows). Re-run 2026-07-18 as part of H1/LIA-433 sign-off: `npx vitest run src/multi-agent/orchestrator.test.ts` — 23/23 passing. |
| Credential-proxy routing | Verified Pass (H1/LIA-433) | Re-run 2026-07-18 as part of H1/LIA-433 sign-off: `npx vitest run src/credential-proxy.test.ts` — 24/24 passing, including both the Claude/Anthropic leg (OAuth + API-key placeholder-credential injection) and the `/openai` route (bearer-auth injection), plus proxy-token rejection and hop-by-hop header stripping. |
| Container tool-broker parity | Release Blocker (H1/LIA-433) | Confirmed 2026-07-18 (H1/LIA-433): no test file exists for `container/agent-runner/src/tool-broker.ts` or `src/agent-runtimes/tool-broker-langchain-adapter.ts` anywhere in the repo. This ADR's own "Verification" section states "Full live verification requires a rebuilt agent container and provider credentials" — neither was available in this sign-off session. Genuine, unresolved gap; needs a dedicated test (or a live container run) before this row can move off Release Blocker. |

## Rollback

Rollback is a single revert while `claude` remains the default. Existing legacy session rows still read as Claude sessions; rows created with `backend='openai'` are ignored when Claude is selected because sessions are backend-scoped.

## OpenAI Adapter Scope Decision

**Date:** 2026-04-26

The OpenAI backend uses the Responses API (`POST /v1/responses`) rather than the OpenAI Agents SDK. This gives Deus full control over the tool-call loop, session compaction, and MCP bridging without depending on OpenAI's orchestration opinions.

Handoffs, tracing, and other Agents SDK features are deferred as optional accelerators, not blockers. If adopted later, they would sit behind the existing `RuntimeCapabilities` flags (`handoffs: false` for OpenAI today).

## Implementation Notes

- OpenAI/Codex tool calls route through `container/agent-runner/src/tool-broker.ts` for filesystem, shell, web, browser, Deus IPC, scheduling, and group registration.
- OpenAI `/compact` stores a Deus-owned continuity summary in `RuntimeSession.metadata_json` and starts the next turn from that summary instead of resuming a synthetic session id as an OpenAI response id.
