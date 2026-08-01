"""Server-parameter resolution for Deus's memory/evolution MCP servers.

Extracted from `integrations/hermes/deus_memory_provider/__init__.py` (LIA-500)
so any consumer - not just the Hermes adapter - can reach these two servers
without re-deriving the interpreter-resolution / env-allowlist logic that PR
#79 hardened through 5 live-caught bugs.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Dict

from mcp import StdioServerParameters

# This file lives at <repo root>/deus_memory_client/servers.py - ONE directory
# below repo root, unlike deus_memory_provider/__init__.py's four (it sits at
# integrations/hermes/deus_memory_provider/__init__.py, behind the Hermes
# symlink). Recomputed here for this file's own, shallower nesting - a
# copy-pasted 4-parent chain would silently resolve 2-3 levels above the real
# repo root and break every server-path lookup below.
REPO_ROOT = Path(__file__).resolve().parent.parent


def _python_has_mcp(python_path: str) -> bool:
    try:
        result = subprocess.run(
            [python_path, "-c", "import mcp"],
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def resolve_python_executable(repo_root: Path = REPO_ROOT) -> str:
    """Find a Python interpreter with the Deus server dependencies installed.

    The two server subprocesses (deus-memory, deus-evolution) need an
    interpreter with google-genai/sqlite-vec/sentence-transformers installed
    (evolution/requirements.txt) - NOT necessarily the caller's own
    interpreter (e.g. Hermes's adapter runs inside Hermes's own pinned env).
    Bare "python3" resolved via inherited PATH is not reliable here -
    confirmed it can resolve to a system interpreter with neither Deus's
    deps nor even the `mcp` package, silently breaking the subprocess
    handshake ("Connection closed") with no clear error surfaced to the
    caller. Mirrors scripts/deus-memory-mcp's own choose_python(): explicit
    override, then this repo's own .venv (verified importable, not just
    present - a partial/broken venv would otherwise be silently selected and
    reproduce the exact failure this resolution exists to avoid), then bare
    "python3" as a last resort.
    """
    override = os.environ.get("DEUS_MEMORY_MCP_PYTHON")
    if override:
        return override

    venv_python = repo_root / ".venv" / "bin" / "python3"
    if venv_python.is_file() and _python_has_mcp(str(venv_python)):
        return str(venv_python)

    return "python3"


# Computed once at import time (mirrors the original module's
# `_PYTHON_EXECUTABLE = _resolve_python_executable()`, PR #79) - NOT
# recomputed per call. `resolve_python_executable()` spawns a probe
# subprocess via `_python_has_mcp()`; recomputing it inside
# `memory_server_params()`/`evolution_server_params()` on every call would
# add a subprocess spawn to every prefetch()/sync_turn() - i.e. every
# conversation turn.
PYTHON_EXECUTABLE = resolve_python_executable()

# mcp.StdioServerParameters's `env` REPLACES the subprocess environment
# entirely (plain subprocess.Popen(env=...) semantics, no merge) - unlike
# Hermes's OWN mcp_servers config-side env handling, which safely merges
# onto a FILTERED os.environ. Passing only {"PYTHONPATH": ...} here silently
# wiped HOME and everything else, which shifted where the evolution DB
# resolved on disk - confirmed: log_interaction_tool returned a real UUID,
# but the row was nowhere in the expected ~/.deus/evolution.db. Must merge
# explicitly - but mirror the choice to allowlist rather than pass the full
# environment through: evolution/config.py's load_api_key() falls back to
# bare os.environ.get("GEMINI_API_KEY", "") when no .env file has a value,
# so blanket-merging the FULL parent env would let the evolution subprocess
# silently authenticate with whatever GEMINI_API_KEY happens to sit in the
# caller's own ambient environment (a different security context) instead of
# failing loudly. Allowlist only what the subprocess actually needs to run
# correctly.
ENV_ALLOWLIST = {"HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"}


def build_evolution_env(repo_root: Path = REPO_ROOT) -> Dict[str, str]:
    """Build the allowlisted, merged (never replaced) env for the evolution server."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key in ENV_ALLOWLIST or key.startswith("XDG_")
    }
    env["PYTHONPATH"] = str(repo_root)
    return env


def memory_server_params(repo_root: Path = REPO_ROOT) -> StdioServerParameters:
    """Params for the deus-memory MCP server - always [python, <script>.py], never the shell launcher."""
    return StdioServerParameters(
        command=PYTHON_EXECUTABLE,
        args=[str(repo_root / "scripts" / "memory_mcp_server.py")],
    )


def evolution_server_params(repo_root: Path = REPO_ROOT) -> StdioServerParameters:
    """Params for the deus-evolution MCP server - always [python, -m, evolution.mcp_server]."""
    return StdioServerParameters(
        command=PYTHON_EXECUTABLE,
        args=["-m", "evolution.mcp_server"],
        cwd=str(repo_root),
        env=build_evolution_env(repo_root),
    )
