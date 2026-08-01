"""Thin MCP stdio client helper for the Deus memory provider.

One instance per target Deus MCP server (deus-memory, deus-evolution). Each
call opens a fresh stdio subprocess + session, calls one tool, and tears the
connection down - no persistent session is kept across turns. This trades a
per-call subprocess-start cost for a much simpler, safer first implementation
(no event-loop-lifetime-vs-sync-hook interactions to get wrong on a
privacy-sensitive integration). A persistent session pool is a reasonable
follow-up optimization, not attempted here.

Never imports any Deus code directly - only speaks MCP protocol to the
already-existing, already-tested deus-memory / deus-evolution servers, each
running in its own separately-pinned Python environment as a subprocess.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

logger = logging.getLogger(__name__)


class McpToolError(RuntimeError):
    """Raised when an MCP tool call fails or returns something unparseable.

    Callers should catch this, log it clearly, and degrade to an empty
    result rather than letting it propagate into a hung turn - "fail loud"
    means logged and visible, not "crash the user's conversation".
    """


async def call_tool(
    server_params: StdioServerParameters,
    tool_name: str,
    arguments: Dict[str, Any],
    *,
    timeout_s: Optional[float] = None,
) -> Dict[str, Any]:
    """Open a stdio session, call one tool, return its parsed JSON result.

    Raises McpToolError on any failure (subprocess start, protocol error,
    unparseable result) - callers decide how to degrade, this function
    never silently returns an empty dict.
    """

    async def _run() -> Dict[str, Any]:
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments=arguments)

        if getattr(result, "isError", False):
            raise McpToolError(f"{tool_name} returned an error result: {result!r}")

        structured = getattr(result, "structuredContent", None)
        if isinstance(structured, dict):
            return structured

        for block in getattr(result, "content", []) or []:
            text = getattr(block, "text", None)
            if text:
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise McpToolError(
                        f"{tool_name} returned non-JSON text content: {exc}"
                    ) from exc
                if isinstance(parsed, dict):
                    return parsed

        raise McpToolError(f"{tool_name} returned no parseable content: {result!r}")

    try:
        if timeout_s is not None:
            return await asyncio.wait_for(_run(), timeout=timeout_s)
        return await _run()
    except asyncio.TimeoutError as exc:
        raise McpToolError(f"{tool_name} timed out after {timeout_s}s") from exc
    except McpToolError:
        raise
    except Exception as exc:  # noqa: BLE001 - deliberately broad: any subprocess/
        # protocol failure must become a clearly-logged McpToolError, never a
        # bare exception that a caller might not expect from this helper.
        raise McpToolError(f"{tool_name} call failed: {exc}") from exc
