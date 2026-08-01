"""Tests for the deus_memory_client Facade (recall / log_interaction)."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import deus_memory_client  # noqa: E402
from deus_memory_client import mcp_client  # noqa: E402


def test_recall_calls_memory_recall_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {}

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        seen["tool_name"] = tool_name
        seen["arguments"] = arguments
        seen["timeout_s"] = timeout_s
        return {"context": "recalled"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)
    result = asyncio.run(deus_memory_client.recall("how do I prune worktrees", k=5, source="test"))

    assert result == {"context": "recalled"}
    assert seen["tool_name"] == "memory_recall"
    assert seen["arguments"] == {"query": "how do I prune worktrees", "k": 5, "source": "test"}
    assert seen["timeout_s"] == 15.0


def test_log_interaction_calls_log_interaction_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {}

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        seen["tool_name"] = tool_name
        seen["arguments"] = arguments
        return {"id": "abc"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)
    result = asyncio.run(
        deus_memory_client.log_interaction(
            "prompt text",
            "response text",
            group_folder="hermes",
            session_id="sess-1",
            diagnostic=True,
        )
    )

    assert result == {"id": "abc"}
    assert seen["tool_name"] == "log_interaction_tool"
    assert seen["arguments"] == {
        "prompt": "prompt text",
        "response": "response text",
        "group_folder": "hermes",
        "session_id": "sess-1",
        "diagnostic": True,
    }


def test_log_interaction_diagnostic_defaults_false(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {}

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        seen["arguments"] = arguments
        return {}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)
    asyncio.run(
        deus_memory_client.log_interaction(
            "p", "r", group_folder="hermes", session_id="sess-1"
        )
    )
    assert seen["arguments"]["diagnostic"] is False


def test_recall_propagates_mcp_tool_error(monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing_call_tool(*args, **kwargs):
        raise mcp_client.McpToolError("boom")

    monkeypatch.setattr(mcp_client, "call_tool", failing_call_tool)
    with pytest.raises(mcp_client.McpToolError):
        asyncio.run(deus_memory_client.recall("query"))
