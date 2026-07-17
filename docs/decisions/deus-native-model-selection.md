# deus-native main and role model selection

**Status:** Accepted  
**Date:** 2026-07-16  
**Scope:** `src/agent-runtimes/model-selection.ts`, `src/agent-runtimes/deus-native-model.ts`, `src/agent-runtimes/deus-native-backend.ts`, `src/agent-runtimes/nested-dispatch-tool.ts`, `src/cli/deus-native-model-config.ts`, `src/cli/deus-native-chat.ts`, `src/cli/deus-native-chat-server.ts`, `src/cli/deus-native-chat-client.ts`  
**Ticket:** LIA-429

## Decision

`deus chat model set|show` manages `~/.config/deus/native-models.json`. A single registry owns supported providers, canonical model IDs, the default, validation, and provider-client construction. Resolution is exact role, then a checked-in per-agent frontmatter default (`.claude/agents/<name>.md` `model:`, when the exact role is not explicitly configured), then configured main, then `anthropic/claude-opus-4-8`.

LIA-411: `dispatch_nested_agent` (the B8 tool) also honors a dispatched agent's `.claude/agents/<name>.md` `model:` frontmatter, when present, for agents dispatched BY NAME through that tool and not otherwise configured via `effectiveModels.roles`. `warden-role-models.ts`'s `loadWardenRoleModels` reads this once at `DeusNativeRuntime` construction (reusing the shared `extractFrontmatter` parser, no duplicate YAML parser), and `resolveWardenModelAlias` maps a bare alias (`sonnet`/`opus`/`haiku`) to its canonical registry id. This is scoped to `dispatch_nested_agent`'s own model resolution only — it does not change how the `codex_warden_hooks.py`-based commit-path gates (plan-review-gate, code-review-gate, ai-eng-gate, verification-gate) select their own model, since those run as a separate Python subprocess path entirely outside `nested-dispatch-tool.ts`.

The chat server reloads validated configuration immediately before each turn and passes only the typed `backendConfig.modelSelection` field through the controller. The runtime uses the registry for the parent and supplies an optional policy to `buildNestedDispatchTool()`. That adapter replaces a parent-requested child model with the configured role/main model before calling the unchanged B8 dispatcher. Effective metadata and usage therefore identify what ran.

## Risk disposition

The production `deus-native` path no longer routes parent-supplied raw model IDs to the credential proxy. Labels without an explicit role config or a mappable frontmatter default inherit validated main/default selection. The generic low-level `createNestedDispatcher({ resolveModel })` API deliberately retains caller-defined raw-string resolution semantics; its independently authored oracle and signature remain unchanged.

## Related

- `deus-v2-subagent-dispatch.md`
- `deus-v2-langchain-runtime.md`
- `deus-native-cli-chat.md`

## Rollback

Remove the command/config path and typed controller field, restore the default parent construction call, and remove the nested-tool policy. Existing config files become inert; no session migration is needed.
