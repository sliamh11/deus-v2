# deus_memory_client

The single choke point for reaching Deus's `deus-memory` / `deus-evolution` MCP servers.
Extracted (LIA-500) from `integrations/hermes/deus_memory_provider/`, where this logic used to
be embedded directly - so any future consumer (not just the Hermes adapter) can call the same
hardened `recall()`/`log_interaction()` without re-deriving interpreter resolution, env
allowlisting, or server-parameter construction from scratch. This is also the intended
attachment point for future privacy-label propagation work (see the map's separate scoping
ticket, LIA-507): one place to instrument, not one per adapter.

## Zero Deus-internal dependency

Only depends on the `mcp` client library - never imports `evolution/`, `scripts/`, or any other
Deus application code. This matters because at least one real consumer
(`integrations/hermes/deus_memory_provider/`) runs inside a *different* process's Python
environment (Hermes's own, via a symlinked plugin directory) where only `mcp` is guaranteed
present.

## API

```python
import deus_memory_client

context = await deus_memory_client.recall("how do I prune merged git worktrees", k=3, source="hermes")
await deus_memory_client.log_interaction(prompt, response, group_folder="hermes", session_id=session_id)
```

Both raise `deus_memory_client.McpToolError` on failure - callers decide how to degrade (see
`integrations/hermes/deus_memory_provider/__init__.py`'s `prefetch()`/`_sync_turn_call()` for
the reference degrade-gracefully pattern).

## Files

- `__init__.py` - the Facade (`recall()`, `log_interaction()`).
- `mcp_client.py` - raw MCP stdio `call_tool()` helper (one subprocess per call, no persistent session).
- `servers.py` - interpreter resolution (`resolve_python_executable()`), env allowlisting
  (`build_evolution_env()`), and `StdioServerParameters` construction for both servers.
- `tests/` - network-free pytest suite (monkeypatched transport/subprocess).

## Consumers

- `integrations/hermes/deus_memory_provider/` - the Hermes `MemoryProvider` adapter.
