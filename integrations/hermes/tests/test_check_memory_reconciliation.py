"""Tests for check_memory_reconciliation.py's own pass/fail logic.

Network-free and subprocess-free: monkeypatches the write side
(``deus_memory_provider.mcp_client.call_tool``, exactly as
``test_deus_memory_provider.py`` already does) and the read side
(``evolution.ilog.interaction_log.get_recent``, mirroring how
``evolution/tests/conftest.py`` already patches evolution internals for its
own hermetic suite), so this proves the script's own reconciliation logic
(match -> 0, omission -> 1, drift -> 1, env error -> 2, retry-loop behavior)
without needing a live judge/vault/evolution.db. This is a hermetic
complement to a real manual run of the script, not a replacement for one
(see README.md).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _stub_memory_provider_abc import install as _install_stub_memory_provider_abc  # noqa: E402

_install_stub_memory_provider_abc()

import deus_memory_provider  # noqa: E402
import check_memory_reconciliation as check  # noqa: E402
from evolution.ilog import interaction_log  # noqa: E402


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    # The retry loop's own delay would otherwise slow every test down for no
    # benefit - these tests exercise retry *count*/ordering, not real timing.
    monkeypatch.setattr(check.time, "sleep", lambda _seconds: None)


@pytest.fixture(autouse=True)
def _fake_write_side(monkeypatch: pytest.MonkeyPatch) -> None:
    # sync_turn()'s background thread calls mcp_client.call_tool() - stub it
    # out the same way test_deus_memory_provider.py does, so no real
    # subprocess/MCP handshake happens.
    async def fake_call_tool(server_params, tool_name, arguments, *, timeout_s=None):
        return {"id": "fake-interaction-id", "status": "logged"}

    monkeypatch.setattr(deus_memory_provider.mcp_client, "call_tool", fake_call_tool)


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Capture the (session_id, prompt, response) sync_turn() actually sent.

    Wraps the REAL sync_turn() (still runs its real thread/shutdown-join
    machinery against the faked call_tool above) so the fake get_recent()
    below can echo back exactly what the script wrote, without hardcoding
    the uuid4-generated tag.
    """
    state: dict = {}
    real_sync_turn = deus_memory_provider.DeusMemoryProvider.sync_turn

    def capturing_sync_turn(self, user_content, assistant_content, *, session_id="", messages=None):
        state["session_id"] = session_id
        state["prompt"] = user_content
        state["response"] = assistant_content
        return real_sync_turn(
            self, user_content, assistant_content, session_id=session_id, messages=messages
        )

    monkeypatch.setattr(deus_memory_provider.DeusMemoryProvider, "sync_turn", capturing_sync_turn)
    return state


def _row_for(session_id: str, prompt: str, response: str) -> dict:
    return {
        "id": "fake-interaction-id",
        "session_id": session_id,
        "prompt": prompt,
        "response": response,
        "group_folder": "hermes",
        "eval_suite": "runtime",
    }


def test_exit_0_when_row_matches_on_first_read(
    monkeypatch: pytest.MonkeyPatch, captured: dict
) -> None:
    calls = {"n": 0}

    def fake_get_recent(*, group_folder, limit, eval_suite):
        calls["n"] += 1
        return [_row_for(captured["session_id"], captured["prompt"], captured["response"])]

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main([]) == 0
    assert calls["n"] == 1


def test_exit_1_omission_when_row_never_found(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def fake_get_recent(*, group_folder, limit, eval_suite):
        calls["n"] += 1
        return []

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main([]) == 1
    # Retries the full bounded budget before giving up - not a single check.
    assert calls["n"] == check._RETRY_ATTEMPTS


def test_exit_1_drift_when_content_mismatch(
    monkeypatch: pytest.MonkeyPatch, captured: dict
) -> None:
    def fake_get_recent(*, group_folder, limit, eval_suite):
        # Same session_id, but WRONG content - simulates drift.
        return [_row_for(captured["session_id"], "something else entirely", "not what was sent")]

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main([]) == 1


def test_exit_2_when_adapter_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(deus_memory_provider.DeusMemoryProvider, "is_available", lambda self: False)
    assert check.main([]) == 2


def test_retry_loop_stops_as_soon_as_row_is_found(
    monkeypatch: pytest.MonkeyPatch, captured: dict
) -> None:
    calls = {"n": 0}

    def fake_get_recent(*, group_folder, limit, eval_suite):
        calls["n"] += 1
        if calls["n"] < 2:
            return []
        return [_row_for(captured["session_id"], captured["prompt"], captured["response"])]

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main([]) == 0
    assert calls["n"] == 2  # stopped as soon as the row appeared, not the full budget


def test_group_folder_override_is_passed_to_get_recent(
    monkeypatch: pytest.MonkeyPatch, captured: dict
) -> None:
    seen_group_folders = []

    def fake_get_recent(*, group_folder, limit, eval_suite):
        seen_group_folders.append(group_folder)
        return [_row_for(captured["session_id"], captured["prompt"], captured["response"])]

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main(["--group-folder", "custom-folder"]) == 0
    assert seen_group_folders == ["custom-folder"]


def test_default_group_folder_matches_adapters_write_target(
    monkeypatch: pytest.MonkeyPatch, captured: dict
) -> None:
    # The adapter's sync_turn() always writes under its own hardcoded
    # _GROUP_FOLDER regardless of any CLI flag - the script's *default* must
    # match that constant, or every default run would self-produce a false
    # omission.
    seen_group_folders = []

    def fake_get_recent(*, group_folder, limit, eval_suite):
        seen_group_folders.append(group_folder)
        return [_row_for(captured["session_id"], captured["prompt"], captured["response"])]

    monkeypatch.setattr(interaction_log, "get_recent", fake_get_recent)

    assert check.main([]) == 0
    assert seen_group_folders == [deus_memory_provider._GROUP_FOLDER]
