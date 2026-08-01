"""Tests for deus_memory_client.mcp_client - network-free, no real MCP subprocess required."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from deus_memory_client import mcp_client  # noqa: E402
from mcp import StdioServerParameters  # noqa: E402

_PARAMS = StdioServerParameters(command="python3", args=["-c", "pass"])


class _FakeResult:
    def __init__(self, *, is_error=False, structured=None, content=None):
        self.isError = is_error
        self.structuredContent = structured
        self.content = content or []


class _FakeBlock:
    def __init__(self, text):
        self.text = text


class _FakeSession:
    def __init__(self, result):
        self._result = result

    async def initialize(self):
        return None

    async def call_tool(self, tool_name, arguments=None):
        return self._result


class _FakeClientSessionCtx:
    def __init__(self, result):
        self._session = _FakeSession(result)

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


class _FakeStdioCtx:
    async def __aenter__(self):
        return (None, None)

    async def __aexit__(self, *exc):
        return False


def _patch_transport(monkeypatch: pytest.MonkeyPatch, result) -> None:
    monkeypatch.setattr(mcp_client, "stdio_client", lambda params: _FakeStdioCtx())
    monkeypatch.setattr(mcp_client, "ClientSession", lambda read, write: _FakeClientSessionCtx(result))


def test_call_tool_returns_structured_content(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, _FakeResult(structured={"context": "hello"}))
    result = asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}))
    assert result == {"context": "hello"}


def test_call_tool_parses_json_text_content(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, _FakeResult(content=[_FakeBlock('{"ok": true}')]))
    result = asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}))
    assert result == {"ok": True}


def test_call_tool_raises_on_is_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, _FakeResult(is_error=True))
    with pytest.raises(mcp_client.McpToolError):
        asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}))


def test_call_tool_raises_on_non_json_text(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, _FakeResult(content=[_FakeBlock("not json")]))
    with pytest.raises(mcp_client.McpToolError):
        asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}))


def test_call_tool_raises_on_no_parseable_content(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, _FakeResult())
    with pytest.raises(mcp_client.McpToolError):
        asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}))


def test_call_tool_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    class _HangingSession:
        async def initialize(self):
            await asyncio.sleep(10)

        async def call_tool(self, *args, **kwargs):
            raise AssertionError("should not reach call_tool after initialize() hangs")

    class _HangingClientSessionCtx:
        async def __aenter__(self):
            return _HangingSession()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(mcp_client, "stdio_client", lambda params: _FakeStdioCtx())
    monkeypatch.setattr(mcp_client, "ClientSession", lambda read, write: _HangingClientSessionCtx())
    with pytest.raises(mcp_client.McpToolError, match="timed out"):
        asyncio.run(mcp_client.call_tool(_PARAMS, "memory_recall", {"query": "x"}, timeout_s=0.05))
