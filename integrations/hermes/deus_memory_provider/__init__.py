"""Deus MemoryProvider adapter for the Hermes Agent System.

Adapts Deus's existing memory/evolution MCP servers to Hermes's
``MemoryProvider`` contract (``agent.memory_provider.MemoryProvider``), so
Hermes gets the same automatic per-turn recall + interaction logging that
Claude Code already gets via its own hooks - without duplicating any Deus
memory/evolution code and without ever importing it directly.

This is an Adapter (over Hermes's ``MemoryProvider`` ABC) wrapping an
MCP-client Strategy (``mcp_client.call_tool``, one call per Deus server) that
does the actual protocol work. Runs inside Hermes's own Python process (this
directory gets symlinked into ``$HERMES_HOME/plugins/deus/`` - see
../README.md) - its only dependency is the ``mcp`` client library, already
present in Hermes's own pinned environment.

Deus's stores stay append/read-only from this side: ``memory_recall`` reads,
``log_interaction_tool`` appends, nothing here ever mutates the vault, atoms,
or reflections stores.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from mcp import StdioServerParameters

from agent.memory_provider import MemoryProvider

from . import mcp_client

logger = logging.getLogger(__name__)

# This file lives at <deus repo>/integrations/hermes/deus_memory_provider/__init__.py
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent


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


def _resolve_python_executable() -> str:
    """Find a Python interpreter with the Deus server dependencies installed.

    This adapter runs INSIDE Hermes's own interpreter (Hermes's own
    sys.executable/pinned env) - the two server subprocesses need a
    DIFFERENT interpreter, one with google-genai/sqlite-vec/sentence-
    transformers installed (evolution/requirements.txt), not Hermes's env.
    Bare "python3" resolved via inherited PATH is not reliable here -
    confirmed this session it can resolve to a system interpreter with
    neither Deus's deps nor even the `mcp` package, silently breaking the
    subprocess handshake ("Connection closed") with no clear error surfaced
    to the caller. Mirrors scripts/deus-memory-mcp's own choose_python():
    explicit override, then this repo's own .venv (verified importable, not
    just present - a partial/broken venv would otherwise be silently
    selected and reproduce the exact failure this resolution exists to
    avoid), then bare "python3" as a last resort.
    """
    override = os.environ.get("DEUS_MEMORY_MCP_PYTHON")
    if override:
        return override

    venv_python = _REPO_ROOT / ".venv" / "bin" / "python3"
    if venv_python.is_file() and _python_has_mcp(str(venv_python)):
        return str(venv_python)

    return "python3"


_PYTHON_EXECUTABLE = _resolve_python_executable()

_MEMORY_SERVER = StdioServerParameters(
    command=_PYTHON_EXECUTABLE,
    args=[str(_REPO_ROOT / "scripts" / "memory_mcp_server.py")],
)
# mcp.StdioServerParameters's `env` REPLACES the subprocess environment
# entirely (plain subprocess.Popen(env=...) semantics, no merge) - unlike
# Hermes's OWN mcp_servers config-side env handling, which safely merges
# onto a FILTERED os.environ (confirmed by reading hermes-agent's
# tools/mcp_tool.py::_build_safe_env - it passes through only a safe
# baseline, not everything). Passing only {"PYTHONPATH": ...} here silently
# wiped HOME and everything else, which shifted where the evolution DB
# resolved on disk - confirmed this session: log_interaction_tool returned a
# real UUID, but the row was nowhere in the expected ~/.deus/evolution.db.
# Must merge explicitly - but mirror Hermes's own choice to allowlist rather
# than pass the full environment through: evolution/config.py's
# load_api_key() falls back to bare os.environ.get("GEMINI_API_KEY", "")
# when no .env file has a value, so blanket-merging the FULL parent env
# would let the evolution subprocess silently authenticate with whatever
# GEMINI_API_KEY happens to sit in Hermes's own ambient environment (a
# different security context) instead of failing loudly. Allowlist only
# what the subprocess actually needs to run correctly.
_ENV_ALLOWLIST = {"HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"}
_EVOLUTION_ENV = {
    key: value
    for key, value in os.environ.items()
    if key in _ENV_ALLOWLIST or key.startswith("XDG_")
}
_EVOLUTION_ENV["PYTHONPATH"] = str(_REPO_ROOT)

_EVOLUTION_SERVER = StdioServerParameters(
    command=_PYTHON_EXECUTABLE,
    args=["-m", "evolution.mcp_server"],
    cwd=str(_REPO_ROOT),
    env=_EVOLUTION_ENV,
)

_PREFETCH_TIMEOUT_S = 15.0
_SYNC_TIMEOUT_S = 30.0

# Deliberate, explicit value - log_interaction_tool's group_folder is a
# required MCP-schema field (evolution/mcp_server.py, no default). Confirmed
# against ../../../groups/ at plan time: no existing channel uses "hermes".
# Deus's per-group memory isolation is core (root CLAUDE.md), so this can't
# be left implicit. See ../README.md for the full rationale, including the
# doc/code inconsistency this deliberately does NOT follow
# (docs/EDITOR_INTEGRATION.md suggests omitting group_folder for a
# different, actually-optional call site).
_GROUP_FOLDER = "hermes"


class DeusMemoryProvider(MemoryProvider):
    """Adapts Deus's memory/evolution MCP servers to Hermes's MemoryProvider ABC."""

    @property
    def name(self) -> str:
        return "deus"

    def __init__(self) -> None:
        self._active_sync_threads: List[threading.Thread] = []
        self._active_sync_threads_lock = threading.Lock()

    def is_available(self) -> bool:
        # Config-only check per the ABC contract (no network calls here):
        # confirm the memory-server script exists. The evolution server is
        # invoked as `python -m evolution.mcp_server` against _REPO_ROOT, so
        # its own presence is implied by the repo checkout existing at all.
        return (_REPO_ROOT / "scripts" / "memory_mcp_server.py").is_file()

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        # "primary" | "subagent" | "cron" | "flush" - sync_turn() skips
        # writes for anything other than "primary" so a cron run or a
        # subagent fork never logs a synthetic interaction into Deus's
        # evolution store as if it were a real user turn.
        self._agent_context = kwargs.get("agent_context", "primary")

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        # The ABC's own docstring confirms /resume, /branch, /reset, /new,
        # gateway equivalents, and context compression can all reassign
        # session_id on this SAME provider instance without tearing it
        # down - session_id is not fixed for the instance's lifetime, so it
        # must be kept current here, not just set once in initialize().
        self._session_id = new_session_id

    def system_prompt_block(self) -> str:
        return (
            "Deus memory is active: relevant personal context is recalled "
            "automatically before each turn, and this conversation is "
            "logged for Deus's own learning loop. No action needed."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        # Run on a dedicated fresh thread, never asyncio.run() directly on
        # the calling thread: Hermes's own call-site threading context for
        # prefetch() isn't confirmed, and if it's ever called from a thread
        # that already has a running event loop, asyncio.run() raises
        # RuntimeError *before* call_tool()'s own exception handling ever
        # runs - uncatchable by `except mcp_client.McpToolError` alone. A
        # brand-new thread structurally cannot have a running loop, so this
        # failure mode is eliminated rather than merely caught. Mirrors why
        # sync_turn() below is already backgrounded the same way.
        outcome: Dict[str, Any] = {}

        def _worker() -> None:
            try:
                outcome["value"] = asyncio.run(
                    mcp_client.call_tool(
                        _MEMORY_SERVER,
                        "memory_recall",
                        {"query": query, "k": 3, "source": "hermes"},
                        timeout_s=_PREFETCH_TIMEOUT_S,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - any failure here must
                # degrade the turn, not crash the caller; logged below.
                outcome["error"] = exc

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        thread.join(timeout=_PREFETCH_TIMEOUT_S + 2.0)

        if "error" in outcome:
            logger.error(
                "deus memory provider: prefetch failed, degrading to no context",
                exc_info=outcome["error"],
            )
            return ""
        if "value" not in outcome:
            logger.error("deus memory provider: prefetch timed out, degrading to no context")
            return ""

        context = outcome["value"].get("context") or ""
        if not context:
            return ""
        return f"[Deus memory]\n{context}"

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if self._agent_context != "primary":
            return
        # Capture the session_id synchronously, here, before the thread
        # starts - never read self._session_id from inside the worker.
        # on_session_switch() can reassign self._session_id on this same
        # instance at any point (see its docstring above), and if a switch
        # races an in-flight background log, reading the mutable instance
        # attribute later would attribute the interaction to the WRONG
        # session. The passed `session_id` argument is the ABC's own
        # mechanism for exactly this ("provided for providers serving
        # concurrent sessions") - prefer it, falling back to the
        # instance's current value only if the caller didn't pass one.
        effective_session_id = session_id or self._session_id
        # Non-blocking per the ABC's contract ("should be non-blocking -
        # queue for background processing if the backend has latency") -
        # fire in a daemon thread; failures are logged, never raised into
        # a thread with nowhere to propagate to.
        thread = threading.Thread(
            target=self._sync_turn_worker,
            args=(user_content, assistant_content, effective_session_id),
            daemon=True,
        )
        # Tracked so shutdown() can wait for in-flight logs before the
        # process exits - see shutdown()'s comment for why this is load-
        # bearing, not defensive-only (confirmed this session: a real CLI
        # one-shot session called shutdown() ~1s after the final turn ended,
        # nowhere near enough time for a fresh subprocess + MCP handshake +
        # tool call to complete, and the interaction was silently dropped
        # before this fix).
        with self._active_sync_threads_lock:
            self._active_sync_threads.append(thread)
        thread.start()

    def _sync_turn_worker(
        self, user_content: str, assistant_content: str, session_id: str
    ) -> None:
        try:
            asyncio.run(
                mcp_client.call_tool(
                    _EVOLUTION_SERVER,
                    "log_interaction_tool",
                    {
                        "prompt": user_content,
                        "response": assistant_content,
                        "group_folder": _GROUP_FOLDER,
                        "session_id": session_id,
                    },
                    timeout_s=_SYNC_TIMEOUT_S,
                )
            )
        except Exception:  # noqa: BLE001 - broad on purpose, matching prefetch()'s
            # worker: this thread has nowhere to propagate to, and asyncio.run()
            # plumbing failures (not just McpToolError) must still be logged,
            # not silently dropped.
            logger.exception("deus memory provider: sync_turn failed to log interaction")
        finally:
            with self._active_sync_threads_lock:
                if threading.current_thread() in self._active_sync_threads:
                    self._active_sync_threads.remove(threading.current_thread())

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Context-only provider - recall/logging happen automatically via
        # prefetch()/sync_turn(), not as model-callable tools. Option A (the
        # deus-memory/deus-evolution MCP servers registered directly with
        # Hermes) already covers the "let the model explicitly call
        # memory_recall" path; this provider isn't a second place to expose
        # that.
        return []

    def shutdown(self) -> None:
        # No persistent connections to close - mcp_client.call_tool() opens
        # and tears down a fresh session per call. But an in-flight
        # sync_turn() background thread from the FINAL turn must be waited
        # for here, or its interaction is silently lost: Hermes calls
        # shutdown() right after the last turn, and a daemon thread gets
        # forcibly killed at process exit regardless of how far it got.
        # Confirmed this session via a real one-shot CLI session -
        # shutdown() fired ~1s after the turn ended, far less than the time
        # a fresh subprocess + MCP handshake + tool call needs, and the
        # interaction never landed in the evolution store.
        # A single shared deadline, not a full timeout budget per thread -
        # with N in-flight threads (rapid back-to-back final turns), giving
        # each its own full _SYNC_TIMEOUT_S+2s budget would let shutdown()
        # block for up to N times that instead of bounded total time.
        with self._active_sync_threads_lock:
            threads = list(self._active_sync_threads)
        deadline = time.monotonic() + _SYNC_TIMEOUT_S + 2.0
        for thread in threads:
            remaining = max(0.0, deadline - time.monotonic())
            thread.join(timeout=remaining)

    def backup_paths(self) -> List[str]:
        # Deliberately empty. Deus's own stores (~/.deus/) already have an
        # independent backup mechanism; letting `hermes backup`/`hermes
        # import` also read/restore them is an untested mutation surface
        # this pass doesn't take on. Must be callable without initialize()
        # per the ABC contract - this is (return [] unconditionally).
        return []
