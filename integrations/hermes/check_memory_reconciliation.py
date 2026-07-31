#!/usr/bin/env python3
"""Reconciliation check between Deus's memory writes and Hermes's reads.

Writes one real interaction through the actual ``DeusMemoryProvider`` adapter
lifecycle (``sync_turn()`` immediately followed by ``shutdown()`` -
deliberately reproducing the exact real-world shape of PR #79's bug: a
one-shot session's final turn followed almost immediately by shutdown), then
reads back the same row directly from ``evolution.db`` and asserts it landed
with the exact content that was written.

Contamination guard: this call passes ``diagnostic=True`` through to
``sync_turn()`` (threaded to ``log_interaction_tool``'s own ``diagnostic``
param - see its docstring in ``evolution/mcp_server.py``). Without it, this
script's synthetic tagged text (``"[reconciliation check <uuid>] prompt"``)
would still go through the REAL judge-eval + reflection-generation path like
any other interaction: the judge would very likely score meaningless
placeholder text below ``REFLECTION_THRESHOLD`` and write a nonsense
"lesson" into the real, shared reflections store under
``deus_memory_provider._GROUP_FOLDER`` ("hermes") - the exact store real
future Hermes conversations retrieve from via ``get_reflections_tool``.
``diagnostic=True`` makes the judge call and reflection generation not
happen at all for this write, while the interaction row itself is still
written and read back normally, so the reconciliation check keeps testing
the real write/read path it exists to test.

Why this reads ``evolution.db`` directly and NOT via ``memory_recall``: the
two are deliberately separate stores with no cross-database joins
(docs/decisions/evolution-db-split.md; memory_tree.py actively ABORTs if it
ever sees evolution tables mixed into memory.db). ``memory_recall`` reads
vault-derived ``memory.db`` (scripts/memory_indexer.py's indexed
``Session-Logs/*.md`` files); ``log_interaction_tool`` (what ``sync_turn()``
calls) writes ``evolution.db``. There is no code path, eventual or lagged,
that makes a freshly-logged interaction visible to ``memory_recall`` - a
check asserting that would report drift on every single run since inception,
regardless of whether anything is actually broken. It also wouldn't catch
the bug this check exists for: PR #79's bug was the row never reaching
``evolution.db`` at all (dropped mid-write on shutdown), which has nothing to
do with vault/semantic-recall visibility. So this check imports
``evolution.ilog.interaction_log`` directly, in-process - the closest thing
to a "provider read" for this data, since the MCP surface exposes no read
tool for interactions (only ``log_interaction_tool``,
``get_reflections_tool``, and friends are registered - see
``evolution/mcp_server.py``).

Env handling: the write subprocess (spawned by the adapter) strips
``DEUS_EVOLUTION_DB`` from its env by design (see
``deus_memory_provider._EVOLUTION_ENV``'s allowlist) - it always resolves
``evolution/config.py``'s default ``~/.deus-v2/evolution.db`` regardless of
what's set in the invoking shell. If this script's own process inherited a
customized ``DEUS_EVOLUTION_DB``, the read side would query a *different*
file than the write actually landed in - a false "omission" caused by this
script's own environment, not a real bug. ``EVOLUTION_DB_PATH`` is a
module-level constant computed once at ``evolution.config`` import time, so
the adapter's own allowlist is applied to ``os.environ`` (saved and
restored) BEFORE the first ``import evolution...`` in this process,
guaranteeing the read side resolves the exact same path the write subprocess
used. If the allowlist itself is ever wrong, this check inherits that
(correctly) rather than silently disagreeing with it.

Exit codes (mirroring scripts/ci/wait_for_checks.py's convention):
    0 - reconciled: the interaction landed with matching content.
    1 - real finding: omission (never landed) or drift (content mismatch).
    2 - environment/usage error (adapter unavailable, mcp missing, import
        failure) - not a finding about the write/read path itself.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

_HERMES_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERMES_DIR))

from _stub_memory_provider_abc import install as _install_stub_memory_provider_abc  # noqa: E402

_install_stub_memory_provider_abc()

# Import order matters here: deus_memory_provider defines _EVOLUTION_ENV (the
# allowlist) without itself importing anything from evolution/. Import it
# first, apply its env allowlist, THEN import evolution.* - so
# evolution.config.EVOLUTION_DB_PATH (a module-level constant computed once
# at import time) resolves against the same env the write subprocess used.
import deus_memory_provider  # noqa: E402

# This script lives outside the repo root's own package tree, so `import
# evolution...` needs the repo root on sys.path explicitly - reuse the
# adapter's own already-computed _REPO_ROOT rather than re-deriving it.
sys.path.insert(0, str(deus_memory_provider._REPO_ROOT))

_RETRY_ATTEMPTS = 3
_RETRY_DELAY_S = 0.5


def _apply_evolution_env() -> dict:
    """Overlay the adapter's own env allowlist onto os.environ.

    Returns the prior values (or a sentinel for keys that were absent) so
    the caller can restore them afterward. Deliberately scoped to only the
    keys the allowlist governs - never touches anything else in os.environ.
    """
    saved: dict = {}
    for key, value in deus_memory_provider._EVOLUTION_ENV.items():
        saved[key] = os.environ.get(key)
        os.environ[key] = value
    # Keys the allowlist DOESN'T include (notably DEUS_EVOLUTION_DB) must be
    # removed entirely, not left as-is - the write subprocess never sees them
    # either, and leaving a customized DEUS_EVOLUTION_DB in this process's
    # env would make the read side resolve a different file than the write
    # subprocess used.
    for key in ("DEUS_EVOLUTION_DB",):
        if key not in deus_memory_provider._EVOLUTION_ENV:
            saved.setdefault(key, os.environ.get(key))
            os.environ.pop(key, None)
    return saved


def _restore_env(saved: dict) -> None:
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--group-folder",
        default=None,
        help="group_folder to read back under for the omission/drift query "
        "(default: deus_memory_provider._GROUP_FOLDER, i.e. whatever the "
        "adapter actually writes under). The adapter's sync_turn() always "
        "writes under its own hardcoded _GROUP_FOLDER regardless of this "
        "flag - overriding it to a value other than that constant will "
        "make the read-back query miss the row it just wrote and report a "
        "false omission. Only override if the adapter's own constant has "
        "changed and this script hasn't been updated yet.",
    )
    args = parser.parse_args(argv)
    group_folder = args.group_folder or deus_memory_provider._GROUP_FOLDER

    provider = deus_memory_provider.DeusMemoryProvider()
    if not provider.is_available():
        print(
            "ENV ERROR: DeusMemoryProvider.is_available() is False - "
            "scripts/memory_mcp_server.py not found relative to the repo "
            "root. Not a reconciliation finding.",
            file=sys.stderr,
        )
        return 2

    tag = f"reconcile-check-{uuid.uuid4()}"
    session_id = tag
    tagged_prompt = f"[reconciliation check {tag}] prompt"
    tagged_response = f"[reconciliation check {tag}] response"

    provider.initialize(session_id=session_id, agent_context="primary")
    # diagnostic=True: see the module docstring's "Contamination guard"
    # section - this is the one thing standing between this script and a
    # synthetic reflection landing in the real, shared "hermes" reflections
    # store on every manual run.
    provider.sync_turn(
        tagged_prompt, tagged_response, session_id=session_id, diagnostic=True
    )
    # Reproduces the exact real-world shape of PR #79's bug: a one-shot
    # session's final turn followed almost immediately by shutdown().
    provider.shutdown()

    saved_env = _apply_evolution_env()
    try:
        from evolution.ilog import interaction_log
    except Exception as exc:  # noqa: BLE001 - import failure is an env
        # error, not a reconciliation finding.
        _restore_env(saved_env)
        print(f"ENV ERROR: failed to import evolution.ilog.interaction_log: {exc}", file=sys.stderr)
        return 2

    try:
        row = None
        for attempt in range(_RETRY_ATTEMPTS):
            rows = interaction_log.get_recent(
                group_folder=group_folder, limit=25, eval_suite=None
            )
            row = next((r for r in rows if r.get("session_id") == session_id), None)
            if row is not None:
                break
            if attempt < _RETRY_ATTEMPTS - 1:
                time.sleep(_RETRY_DELAY_S)
    finally:
        _restore_env(saved_env)

    if row is None:
        print(
            f"FINDING (omission): interaction with session_id={session_id!r} "
            f"did not land in evolution.db within "
            f"{_RETRY_ATTEMPTS * _RETRY_DELAY_S:.1f}s of shutdown() returning.",
            file=sys.stderr,
        )
        return 1

    mismatches = []
    if row.get("prompt") != tagged_prompt:
        mismatches.append(f"prompt: wrote {tagged_prompt!r}, read {row.get('prompt')!r}")
    if row.get("response") != tagged_response:
        mismatches.append(f"response: wrote {tagged_response!r}, read {row.get('response')!r}")

    if mismatches:
        print("FINDING (drift): content mismatch on read-back:", file=sys.stderr)
        for mismatch in mismatches:
            print(f"  - {mismatch}", file=sys.stderr)
        return 1

    print(f"OK: reconciled - session_id={session_id!r} matched on write/read-back.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
