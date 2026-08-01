"""Deus MemoryProvider adapter for the Hermes Agent System.

Adapts Deus's existing memory/evolution MCP servers to Hermes's
``MemoryProvider`` contract (``agent.memory_provider.MemoryProvider``), so
Hermes gets the same automatic per-turn recall + interaction logging that
Claude Code already gets via its own hooks - without duplicating any Deus
memory/evolution code and without ever importing it directly.

This is an Adapter (over Hermes's ``MemoryProvider`` ABC) wrapping
``deus_memory_client`` (LIA-500) - the shared Facade that does the actual
MCP protocol work (interpreter resolution, env allowlisting, server-param
construction, the raw stdio call). Runs inside Hermes's own Python process
(this directory gets symlinked into ``$HERMES_HOME/plugins/deus/`` - see
../README.md). Never imports Deus's application code (``evolution/``,
``scripts/``) directly - only ``deus_memory_client`` (deliberately
lightweight, itself only depending on the ``mcp`` client library already
present in Hermes's own pinned environment) and that same ``mcp`` library.

Deus's stores stay append/read-only from this side: ``memory_recall`` reads,
``log_interaction_tool`` appends, nothing here ever mutates the vault, atoms,
or reflections stores.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

# This file lives at <deus repo>/integrations/hermes/deus_memory_provider/__init__.py
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent

# `deus_memory_client` is a top-level sibling package at the repo root, not a
# subpackage of this symlinked-into-Hermes directory - `_REPO_ROOT` resolves
# through the Hermes symlink back to the real checkout (Path.resolve()
# follows symlinks), same mechanism already used above to locate
# scripts/memory_mcp_server.py. If you're tempted to "fix" this sys.path
# insert as a stray leftover - it isn't; deus_memory_client has zero
# dependency on evolution/ or any other heavy Deus internal, only on the
# `mcp` library already present in Hermes's env, so reaching it this way
# doesn't reintroduce the "no Deus dependency in Hermes's env" constraint
# this module's docstring describes.
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import deus_memory_client  # noqa: E402
from deus_memory_client import mcp_client  # noqa: E402 - re-exported for existing callers/tests

_EVOLUTION_ENV = deus_memory_client.servers.build_evolution_env(_REPO_ROOT)

_PREFETCH_TIMEOUT_S = 15.0
_SYNC_TIMEOUT_S = 30.0

# Bounds how many sync_turn() background threads can actually be spawning
# subprocesses at once, process-wide (not per-session - each Hermes session
# gets its own provider instance, but the host's subprocess/resource load is
# a shared, process-wide concern). sync_turn() itself stays non-blocking per
# the ABC's contract; excess calls queue at this semaphore inside the worker
# rather than each spawning a concurrent subprocess immediately. A fast
# back-to-back conversation (or several concurrent sessions) would otherwise
# spawn one concurrent subprocess-backed thread per turn with no cap.
_SYNC_TURN_CONCURRENCY_LIMIT = 3
_sync_turn_semaphore = threading.BoundedSemaphore(_SYNC_TURN_CONCURRENCY_LIMIT)

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
                    deus_memory_client.recall(
                        query, k=3, source="hermes", timeout_s=_PREFETCH_TIMEOUT_S
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
        diagnostic: bool = False,
    ) -> None:
        # `diagnostic` is deliberately NOT part of Hermes's MemoryProvider ABC
        # (see agent.memory_provider.MemoryProvider.sync_turn's signature,
        # stubbed in ../_stub_memory_provider_abc.py) - it's an extra,
        # optional, keyword-only param this concrete adapter accepts beyond
        # the ABC's contract. Hermes itself never passes it (defaults to
        # False, production behavior unchanged); only an in-process caller
        # that holds a concrete DeusMemoryProvider instance directly - e.g.
        # check_memory_reconciliation.py - can opt a specific write into
        # diagnostic mode. See log_interaction_tool's own docstring
        # (evolution/mcp_server.py) for why this exists: synthetic/self-test
        # content must never be able to trigger a real judge call + reflection
        # write into the shared, real `_GROUP_FOLDER` reflections store.
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
            args=(user_content, assistant_content, effective_session_id, diagnostic),
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
        self,
        user_content: str,
        assistant_content: str,
        session_id: str,
        diagnostic: bool = False,
    ) -> None:
        # Blocks here (not in sync_turn()) if _SYNC_TURN_CONCURRENCY_LIMIT
        # subprocess-backed calls are already in flight process-wide - the
        # thread is already tracked in self._active_sync_threads before it
        # gets here, so shutdown()'s join() still correctly waits for it
        # even while it's queued at the semaphore, not yet doing real work.
        with _sync_turn_semaphore:
            self._sync_turn_call(user_content, assistant_content, session_id, diagnostic)

    def _sync_turn_call(
        self,
        user_content: str,
        assistant_content: str,
        session_id: str,
        diagnostic: bool = False,
    ) -> None:
        try:
            asyncio.run(
                deus_memory_client.log_interaction(
                    user_content,
                    assistant_content,
                    group_folder=_GROUP_FOLDER,
                    session_id=session_id,
                    diagnostic=diagnostic,
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
        # A thread can still be alive here in two cases: it was genuinely
        # queued at _sync_turn_semaphore (never got a slot before the shared
        # deadline - more likely now that the semaphore can make a thread
        # wait before it even starts its call) or its own call is still
        # running past the deadline. Either way its interaction will be
        # dropped when this daemon thread is killed at process exit - log it
        # so a burst well above the concurrency limit leaves a visible signal
        # instead of a silent, unexplained gap in the evolution store.
        still_alive = [t for t in threads if t.is_alive()]
        if still_alive:
            logger.warning(
                "deus memory provider: shutdown() deadline reached with %d "
                "sync_turn thread(s) still active - their interactions may "
                "be dropped",
                len(still_alive),
            )

    def backup_paths(self) -> List[str]:
        # Deliberately empty. Deus's own stores (~/.deus/) already have an
        # independent backup mechanism; letting `hermes backup`/`hermes
        # import` also read/restore them is an untested mutation surface
        # this pass doesn't take on. Must be callable without initialize()
        # per the ABC contract - this is (return [] unconditionally).
        return []
