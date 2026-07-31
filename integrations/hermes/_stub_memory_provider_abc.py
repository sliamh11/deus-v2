"""Shared stub for Hermes's ``agent.memory_provider.MemoryProvider`` ABC.

Hermes's own `agent.memory_provider` module isn't importable outside a real
Hermes install. Both the adapter's test suite
(``tests/test_deus_memory_provider.py``) and the reconciliation check script
(``check_memory_reconciliation.py``) need to import
``deus_memory_provider.DeusMemoryProvider`` standalone, which in turn imports
``from agent.memory_provider import MemoryProvider`` at module scope - so
both call sites need this stub installed into ``sys.modules`` first.

Extracted from the test file (was previously duplicated logic) so there is
exactly one definition of the ABC's shape (CLAUDE.md: never duplicate content
across files - duplication is drift waiting to happen). Covers only the
methods the adapter actually uses; not a full reimplementation of Hermes's
real ABC.
"""
from __future__ import annotations

import sys
import types
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional


def install() -> None:
    """Install the stub ABC into ``sys.modules`` if not already present.

    Idempotent - safe to call from multiple import sites (test collection
    and the check script may both run in the same process, e.g. under
    pytest collecting the check script's own test module).
    """
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
