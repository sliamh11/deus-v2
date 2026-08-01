"""deus_memory_client - the single choke point for reaching Deus's memory/evolution MCP servers.

Facade over `mcp_client` (raw MCP stdio protocol) and `servers` (interpreter
resolution + server-parameter construction): every consumer that wants to
recall or log through Deus's memory layer calls `recall()`/`log_interaction()`
here rather than talking to the two servers directly. This is the extraction
point LIA-500 exists to create - a future privacy-label propagation pass has
ONE place to instrument, not one per adapter.

Zero Deus-internal dependency beyond the `mcp` client library, same as the
code this was extracted from (`integrations/hermes/deus_memory_provider/`,
PR #79/#80) - so it stays safe to import from inside a consumer's own
process (e.g. Hermes's), not just from within this repo's own venv.
"""
from __future__ import annotations

from typing import Any, Dict

from . import mcp_client, servers
from .mcp_client import McpToolError
from .servers import REPO_ROOT

__all__ = ["recall", "log_interaction", "McpToolError", "mcp_client", "servers", "REPO_ROOT"]


async def recall(
    query: str,
    *,
    k: int = 3,
    source: str = "hermes",
    timeout_s: float = 15.0,
) -> Dict[str, Any]:
    """Call the deus-memory server's `memory_recall` tool. Raises McpToolError on failure."""
    return await mcp_client.call_tool(
        servers.memory_server_params(),
        "memory_recall",
        {"query": query, "k": k, "source": source},
        timeout_s=timeout_s,
    )


async def log_interaction(
    prompt: str,
    response: str,
    *,
    group_folder: str,
    session_id: str,
    diagnostic: bool = False,
    timeout_s: float = 30.0,
) -> Dict[str, Any]:
    """Call the deus-evolution server's `log_interaction_tool`. Raises McpToolError on failure."""
    return await mcp_client.call_tool(
        servers.evolution_server_params(),
        "log_interaction_tool",
        {
            "prompt": prompt,
            "response": response,
            "group_folder": group_folder,
            "session_id": session_id,
            "diagnostic": diagnostic,
        },
        timeout_s=timeout_s,
    )
