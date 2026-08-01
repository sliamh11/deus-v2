"""Tests for deus_memory_client.servers - interpreter resolution, env allowlist, server params."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from deus_memory_client import servers  # noqa: E402


def test_resolve_python_executable_prefers_explicit_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEUS_MEMORY_MCP_PYTHON", "/custom/python3")
    assert servers.resolve_python_executable() == "/custom/python3"


def test_resolve_python_executable_uses_venv_when_importable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("DEUS_MEMORY_MCP_PYTHON", raising=False)
    venv_python = tmp_path / ".venv" / "bin" / "python3"
    venv_python.parent.mkdir(parents=True)
    venv_python.touch()
    monkeypatch.setattr(servers, "_python_has_mcp", lambda path: path == str(venv_python))
    assert servers.resolve_python_executable(tmp_path) == str(venv_python)


def test_resolve_python_executable_falls_back_to_bare_python3_when_venv_broken(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("DEUS_MEMORY_MCP_PYTHON", raising=False)
    venv_python = tmp_path / ".venv" / "bin" / "python3"
    venv_python.parent.mkdir(parents=True)
    venv_python.touch()
    # venv exists but doesn't actually have `mcp` importable - must not be silently selected.
    monkeypatch.setattr(servers, "_python_has_mcp", lambda path: False)
    assert servers.resolve_python_executable(tmp_path) == "python3"


def test_resolve_python_executable_falls_back_when_venv_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("DEUS_MEMORY_MCP_PYTHON", raising=False)
    assert servers.resolve_python_executable(tmp_path) == "python3"


def test_build_evolution_env_merges_onto_allowlist_not_full_passthrough(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", "/home/test")
    monkeypatch.setenv("GEMINI_API_KEY", "should-not-leak-through")
    env = servers.build_evolution_env(tmp_path)
    assert env["HOME"] == "/home/test"
    assert env["PYTHONPATH"] == str(tmp_path)
    assert "GEMINI_API_KEY" not in env


def test_build_evolution_env_passes_through_xdg_prefixed_vars(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg/config")
    env = servers.build_evolution_env(tmp_path)
    assert env["XDG_CONFIG_HOME"] == "/xdg/config"


def test_memory_server_params_invokes_python_script_never_shell_launcher(tmp_path: Path) -> None:
    params = servers.memory_server_params(tmp_path)
    assert params.command == servers.PYTHON_EXECUTABLE
    assert params.args == [str(tmp_path / "scripts" / "memory_mcp_server.py")]
    assert "deus-memory-mcp" not in " ".join(params.args)


def test_evolution_server_params_invokes_module_form(tmp_path: Path) -> None:
    params = servers.evolution_server_params(tmp_path)
    assert params.command == servers.PYTHON_EXECUTABLE
    assert params.args == ["-m", "evolution.mcp_server"]
    assert params.cwd == str(tmp_path)
    assert params.env["PYTHONPATH"] == str(tmp_path)


def test_memory_and_evolution_server_params_do_not_reresolve_interpreter_per_call(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # PYTHON_EXECUTABLE must be a module-level constant computed once at
    # import time (mirrors the pre-extraction `_PYTHON_EXECUTABLE`) - NOT
    # recomputed inside memory_server_params()/evolution_server_params() on
    # every call, or every prefetch()/sync_turn() (i.e. every conversation
    # turn) would gain an extra subprocess spawn via resolve_python_executable()'s
    # own _python_has_mcp() probe. Regression guard: poison
    # resolve_python_executable itself and confirm neither params function
    # ever calls it.
    calls = []
    monkeypatch.setattr(
        servers,
        "resolve_python_executable",
        lambda *a, **kw: calls.append((a, kw)) or (_ for _ in ()).throw(
            AssertionError("resolve_python_executable() must not be called per-call")
        ),
    )

    servers.memory_server_params(tmp_path)
    servers.memory_server_params(tmp_path)
    servers.evolution_server_params(tmp_path)
    servers.evolution_server_params(tmp_path)

    assert calls == []


def test_repo_root_resolves_to_actual_repo_root() -> None:
    # servers.py lives at <repo root>/deus_memory_client/servers.py - one
    # directory below repo root. REPO_ROOT must land on the repo root itself,
    # confirmed by the presence of a file only the real repo root would have.
    assert (servers.REPO_ROOT / "deus_memory_client").is_dir()
    assert servers.REPO_ROOT.name != "deus_memory_client"
