"""Tests for the Deus MemoryProvider adapter (integrations/hermes/).

Network-free, no real Hermes install or MCP subprocess required - mirrors
integrations/odysseus/tests/test_odysseus_bridge.py's monkeypatch style.

Hermes's own `agent.memory_provider.MemoryProvider` ABC isn't importable
outside a real Hermes install, so a minimal stub covering the methods this
provider actually uses is injected into sys.modules before the real package
is imported - this is what lets these tests run standalone in the Deus
repo's own CI.
"""
from __future__ import annotations

import asyncio
import sys
import threading
import time
import types
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest


def _install_stub_memory_provider_abc() -> None:
    if "agent.memory_provider" in sys.modules:
        return

    agent_pkg = types.ModuleType("agent")
    agent_pkg.__path__ = []  # mark as a package
    memory_provider_mod = types.ModuleType("agent.memory_provider")

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...

        @abstractmethod
        def is_available(self) -> bool: ...

        @abstractmethod
        def initialize(self, session_id: str, **kwargs) -> None: ...

        def system_prompt_block(self) -> str:
            return ""

        def prefetch(self, query: str, *, session_id: str = "") -> str:
            return ""

        def sync_turn(
            self,
            user_content: str,
            assistant_content: str,
            *,
            session_id: str = "",
            messages: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            pass

        @abstractmethod
        def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

        def shutdown(self) -> None:
            pass

        def on_session_switch(
            self,
            new_session_id: str,
            *,
            parent_session_id: str = "",
            reset: bool = False,
            rewound: bool = False,
            **kwargs,
        ) -> None:
            pass

        def backup_paths(self) -> List[str]:
            return []

    memory_provider_mod.MemoryProvider = MemoryProvider
    sys.modules["agent"] = agent_pkg
    sys.modules["agent.memory_provider"] = memory_provider_mod


_install_stub_memory_provider_abc()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from deus_memory_provider import DeusMemoryProvider, mcp_client  # noqa: E402


@pytest.fixture()
def provider() -> DeusMemoryProvider:
    return DeusMemoryProvider()


def test_name_is_deus(provider: DeusMemoryProvider) -> None:
    assert provider.name == "deus"


def test_get_tool_schemas_is_empty(provider: DeusMemoryProvider) -> None:
    assert provider.get_tool_schemas() == []


def test_backup_paths_is_empty_without_initialize() -> None:
    # Contract requirement: callable without initialize() and without network.
    assert DeusMemoryProvider().backup_paths() == []


def test_is_available_true_when_launcher_exists(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_repo = tmp_path
    (fake_repo / "scripts").mkdir()
    (fake_repo / "scripts" / "memory_mcp_server.py").write_text("# stub\n")
    import deus_memory_provider as dmp

    monkeypatch.setattr(dmp, "_REPO_ROOT", fake_repo)
    assert provider.is_available() is True


def test_is_available_false_when_launcher_missing(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import deus_memory_provider as dmp

    monkeypatch.setattr(dmp, "_REPO_ROOT", tmp_path)
    assert provider.is_available() is False


def test_initialize_sets_session_and_defaults_agent_context_primary(
    provider: DeusMemoryProvider,
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    assert provider._session_id == "sess-1"
    assert provider._agent_context == "primary"


def test_initialize_respects_explicit_agent_context(provider: DeusMemoryProvider) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cron", agent_context="cron")
    assert provider._agent_context == "cron"


def test_on_session_switch_updates_session_id(provider: DeusMemoryProvider) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    provider.on_session_switch("sess-2", reset=False)
    assert provider._session_id == "sess-2"


def test_prefetch_calls_memory_recall_and_formats_context(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    calls = {}

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        calls["server_params"] = server_params
        calls["tool_name"] = tool_name
        calls["arguments"] = arguments
        return {"context": "the user prefers dark mode", "paths": ["x.md"], "confidence": 0.8, "fell_back": False}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    result = provider.prefetch("what does the user prefer?", session_id="sess-1")

    assert calls["tool_name"] == "memory_recall"
    assert calls["arguments"]["query"] == "what does the user prefer?"
    assert "dark mode" in result
    assert result.startswith("[Deus memory]")


def test_prefetch_degrades_to_empty_string_on_failure(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")

    async def failing_call_tool(*args, **kwargs):
        raise mcp_client.McpToolError("subprocess did not start")

    monkeypatch.setattr(mcp_client, "call_tool", failing_call_tool)

    assert provider.prefetch("anything", session_id="sess-1") == ""


def test_prefetch_empty_context_returns_empty_string(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")

    async def empty_call_tool(*args, **kwargs):
        return {"context": "", "paths": [], "confidence": 0.0, "fell_back": True}

    monkeypatch.setattr(mcp_client, "call_tool", empty_call_tool)

    assert provider.prefetch("anything", session_id="sess-1") == ""


def test_sync_turn_logs_interaction_with_hermes_group_folder(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    calls = {}
    done = {"flag": False}

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        calls["server_params"] = server_params
        calls["tool_name"] = tool_name
        calls["arguments"] = arguments
        done["flag"] = True
        return {"id": "abc123", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    provider.sync_turn("hello", "hi there", session_id="sess-1")

    for _ in range(50):
        if done["flag"]:
            break
        time.sleep(0.02)

    assert done["flag"] is True
    assert calls["tool_name"] == "log_interaction_tool"
    assert calls["arguments"]["group_folder"] == "hermes"
    assert calls["arguments"]["prompt"] == "hello"
    assert calls["arguments"]["response"] == "hi there"


def test_sync_turn_skips_non_primary_agent_context(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cron", agent_context="cron")
    invoked = {"flag": False}

    async def fake_call_tool(*args, **kwargs):
        invoked["flag"] = True
        return {"id": "x", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    provider.sync_turn("hello", "hi there", session_id="sess-1")
    time.sleep(0.1)

    assert invoked["flag"] is False


def test_sync_turn_failure_is_logged_not_raised(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")

    async def failing_call_tool(*args, **kwargs):
        raise mcp_client.McpToolError("evolution server unreachable")

    monkeypatch.setattr(mcp_client, "call_tool", failing_call_tool)

    with caplog.at_level("ERROR"):
        provider.sync_turn("hello", "hi there", session_id="sess-1")
        for _ in range(50):
            if any(
                "sync_turn failed to log interaction" in record.message
                for record in caplog.records
            ):
                break
            time.sleep(0.02)

    assert any(
        "sync_turn failed to log interaction" in record.message for record in caplog.records
    )


def test_sync_turn_captures_session_id_before_a_racing_switch(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression test for the exact race ai-eng-warden flagged: on_session_switch()
    # can reassign self._session_id while a background sync_turn log is still
    # in flight. The logged interaction must carry the session_id that was
    # current WHEN sync_turn() was called, not whatever self._session_id
    # happens to be by the time the worker thread actually runs.
    #
    # A first version of this test relied on incidental OS thread-scheduling
    # order (call sync_turn(), then immediately on_session_switch()) and was
    # proven via mutation testing NOT to discriminate the fix from the bug -
    # the worker consistently finished before the switch happened either way.
    # This version forces the interleave with real synchronization: the fake
    # call blocks until the test explicitly signals it, and the test only
    # signals AFTER on_session_switch() has already run - so the switch is
    # guaranteed to happen while the "network call" is genuinely in flight.
    provider.initialize("sess-original", hermes_home="/tmp/.hermes", platform="cli")
    calls = {}
    worker_started = threading.Event()
    worker_may_proceed = threading.Event()

    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        worker_started.set()
        worker_may_proceed.wait(timeout=5)
        calls["arguments"] = arguments
        return {"id": "abc123", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    provider.sync_turn("hello", "hi there", session_id="sess-original")
    assert worker_started.wait(timeout=2), "worker thread did not start in time"

    provider.on_session_switch("sess-new")  # now guaranteed to race an in-flight call
    worker_may_proceed.set()

    for _ in range(100):
        if "arguments" in calls:
            break
        time.sleep(0.02)

    assert calls.get("arguments", {}).get("session_id") == "sess-original"
    assert provider._session_id == "sess-new"  # the switch itself still applied


def test_sync_turn_binds_session_id_before_starting_thread(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Cheaper, fully deterministic complement to the interleaving test above -
    # proves the capture-before-dispatch property with no real concurrency at
    # all, by intercepting Thread construction itself.
    provider.initialize("sess-original", hermes_home="/tmp/.hermes", platform="cli")
    captured = {}

    class NonStartingThread:
        def __init__(self, target=None, args=(), daemon=None):
            captured["args"] = args
            self._target = target

        def start(self) -> None:
            pass  # deliberately never runs the target

    import deus_memory_provider as dmp

    monkeypatch.setattr(dmp.threading, "Thread", NonStartingThread)

    provider.sync_turn("hello", "hi there", session_id="sess-original")
    provider.on_session_switch("sess-new")

    # args = (user_content, assistant_content, effective_session_id)
    assert captured["args"][2] == "sess-original"


def test_prefetch_does_not_raise_when_called_from_a_running_event_loop(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression test for the original code-reviewer finding: prefetch() must
    # never call asyncio.run() on the thread that invoked it, because Hermes's
    # own call-site threading context isn't guaranteed loop-free. This drives
    # prefetch() from inside a coroutine (i.e. from a thread with a genuinely
    # running event loop) - the old implementation would raise
    # "RuntimeError: asyncio.run() cannot be called from a running event
    # loop" here; the fix (a dedicated worker thread inside prefetch())
    # must not.
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")

    async def fake_call_tool(*args, **kwargs):
        return {"context": "recalled text", "paths": [], "confidence": 0.9, "fell_back": False}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    result_holder: Dict[str, str] = {}

    async def caller_with_running_loop() -> None:
        result_holder["value"] = provider.prefetch("some query", session_id="sess-1")

    asyncio.run(caller_with_running_loop())  # does not raise

    assert "recalled text" in result_holder["value"]


def test_shutdown_waits_for_in_flight_sync_turn(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression test for a real, reproduced data-loss bug: a live one-shot
    # CLI session called shutdown() ~1s after the final turn ended - nowhere
    # near enough time for sync_turn()'s background thread (subprocess spawn
    # + MCP handshake + tool call) to complete, and the interaction was
    # silently dropped when the daemon thread got killed at process exit.
    # shutdown() must block until any in-flight sync_turn() completes.
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    call_started = threading.Event()
    call_may_finish = threading.Event()
    call_completed = threading.Event()

    async def slow_call_tool(*args, **kwargs):
        call_started.set()
        call_may_finish.wait(timeout=5)
        call_completed.set()
        return {"id": "abc", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", slow_call_tool)

    provider.sync_turn("hello", "hi there", session_id="sess-1")
    assert call_started.wait(timeout=2), "background call did not start in time"

    # Let shutdown() start blocking on the still-in-flight thread, then
    # release the call - if shutdown() returned early (the bug), the
    # interaction would be lost the moment the process exits after this.
    call_may_finish.set()
    provider.shutdown()

    assert call_completed.is_set()
    assert provider._active_sync_threads == []


def test_shutdown_with_no_in_flight_work_returns_immediately(
    provider: DeusMemoryProvider,
) -> None:
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    start = time.monotonic()
    provider.shutdown()
    assert time.monotonic() - start < 1.0


def test_shutdown_uses_a_shared_deadline_across_multiple_in_flight_threads(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression test for the ai-eng-warden finding: joining each in-flight
    # thread with its own full timeout budget lets shutdown() block for up
    # to N times that with N concurrent threads. shutdown() must instead
    # share a single deadline across all of them - each hangs briefly
    # (longer than the shared budget), so if shutdown() gave each its own
    # full per-thread timeout this test would take ~2x that; it must
    # instead return close to the single shared budget.
    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")
    import deus_memory_provider as dmp

    monkeypatch.setattr(dmp, "_SYNC_TIMEOUT_S", 1.0)  # shared deadline ~= 3.0s

    hold = threading.Event()  # never set - both calls hang until join() times out

    async def hanging_call_tool(*args, **kwargs):
        hold.wait(timeout=30)
        return {"id": "x", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", hanging_call_tool)

    provider.sync_turn("first", "response one", session_id="sess-1")
    provider.sync_turn("second", "response two", session_id="sess-1")
    for _ in range(50):
        if len(provider._active_sync_threads) == 2:
            break
        time.sleep(0.02)
    assert len(provider._active_sync_threads) == 2

    start = time.monotonic()
    provider.shutdown()
    elapsed = time.monotonic() - start

    # Shared deadline (~3.0s) for BOTH threads together, not ~3.0s EACH
    # (~6.0s total) - generous upper bound to stay non-flaky under load.
    assert elapsed < 5.0, f"shutdown() took {elapsed:.1f}s - deadline is not shared across threads"


def test_sync_turn_bounds_concurrent_subprocess_spawns(
    provider: DeusMemoryProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression test for the "Not covered by this pass" fan-out item: a fast
    # back-to-back conversation must not spawn unbounded concurrent
    # subprocess-backed calls. Fires more sync_turn() calls than the
    # configured limit and asserts the observed concurrent-in-flight count
    # never exceeds it, using a counter guarded by its own lock (independent
    # of the provider's own semaphore, so this genuinely observes behavior
    # rather than trivially agreeing with the mechanism under test).
    import deus_memory_provider as dmp

    provider.initialize("sess-1", hermes_home="/tmp/.hermes", platform="cli")

    limit = dmp._SYNC_TURN_CONCURRENCY_LIMIT
    assert limit >= 1
    n_calls = limit + 3

    lock = threading.Lock()
    in_flight = 0
    max_observed = 0
    release = threading.Event()

    async def fake_call_tool(*args, **kwargs):
        nonlocal in_flight, max_observed
        with lock:
            in_flight += 1
            max_observed = max(max_observed, in_flight)
        release.wait(timeout=5)
        with lock:
            in_flight -= 1
        return {"id": "x", "status": "logged"}

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)

    for i in range(n_calls):
        provider.sync_turn(f"prompt {i}", f"response {i}", session_id="sess-1")

    # Settle for a FIXED, generous window before checking - not a break-on-
    # first-threshold-touch race. A prior version of this test broke out of
    # its polling loop the instant max_observed first reached the limit, then
    # immediately set `release` - reproduced (via mutation testing) to
    # spuriously pass ~20% of the time against genuinely UNBOUNDED code,
    # because a slow-to-start thread (real asyncio.run()/thread-spawn
    # overhead ahead of it) could still be arriving after release() already
    # fired, sailing through without ever overlapping another call. Waiting a
    # fixed window long enough for every dispatched thread to have had a
    # chance to enter fake_call_tool closes that race: under genuinely
    # bounded code, excess threads are stuck at the semaphore's acquire() and
    # CANNOT enter fake_call_tool no matter how long we wait, so max_observed
    # stays capped at `limit` regardless of settle time; under unbounded code
    # every thread reaches fake_call_tool with nothing gating it, so given
    # enough time max_observed correctly climbs past `limit`.
    time.sleep(1.0)

    release.set()
    for thread in list(provider._active_sync_threads):
        thread.join(timeout=5)

    assert max_observed <= limit, f"observed {max_observed} concurrent calls, limit is {limit}"
