"""Shadow-enforcement telemetry and detached-launch helpers (LIA-413).

The Claude Code hook remains authoritative.  This leaf records its tagged
outcome, runs the same Python gate under the middleware workspace profile, and
compares the two append-only records.  Orphan detection is intentionally lazy:
an idle telemetry bucket is reconciled only when the next tagged invocation
touches it.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
except ImportError:  # pragma: no cover - production shim is macOS/Linux-only
    fcntl = None  # type: ignore[assignment]


OUTCOME_FILENAME = ".warden-double-enforce.jsonl"
DIVERGENCE_FILENAME = ".warden-double-enforce-divergences.jsonl"
ORPHAN_AFTER_SECONDS = 30.0

_INVOCATIONS = frozenset({"cc-hook", "middleware"})
_DECISIONS = frozenset({"allow", "deny", "error"})
_MISMATCHES = frozenset(
    {
        "decision",
        "feedback",
        "missing_cc_hook",
        "missing_middleware",
        "secondary_launch",
    }
)

Outcome = dict[str, Any]
WorktreeResolver = Callable[[Path, Path], Path | None]
MarkerDirResolver = Callable[[Path, Path], Path]


def correlation_store_paths(
    repo_root: Path,
    event_cwd: Path,
    *,
    worktree_resolver: WorktreeResolver,
    marker_dir_resolver: MarkerDirResolver,
) -> tuple[Path, Path]:
    """Resolve telemetry solely from the hook event cwd.

    The explicit resolver dependencies are deliberate: this path must never
    consult the verdict store's ``--workspace-root`` / ``_WORKTREE_OVERRIDE``
    state.  Malformed or outside-repository events fall back to the main bucket.
    """

    try:
        resolved_cwd = Path(event_cwd).resolve(strict=False)
        worktree = worktree_resolver(resolved_cwd, repo_root)
    except (OSError, TypeError, ValueError):
        worktree = None
    marker_dir = marker_dir_resolver(repo_root, worktree or repo_root)
    return marker_dir / OUTCOME_FILENAME, marker_dir / DIVERGENCE_FILENAME


def _sanitize_reason(reason: object, *, limit: int = 1_000) -> str | None:
    if reason is None:
        return None
    text = str(reason)
    text = " ".join(text.split())
    if not text:
        return None
    return text[:limit]


def _deny_reason(stdout: str) -> str | None:
    """Return the exact block reason only for ``_block_pre_tool`` protocol."""

    if not stdout.endswith("\n") or stdout.endswith("\n\n"):
        return None
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict) or set(payload) != {"hookSpecificOutput"}:
        return None
    specific = payload.get("hookSpecificOutput")
    if not isinstance(specific, dict) or set(specific) != {
        "hookEventName",
        "permissionDecision",
        "permissionDecisionReason",
    }:
        return None
    reason = specific.get("permissionDecisionReason")
    if (
        specific.get("hookEventName") != "PreToolUse"
        or specific.get("permissionDecision") != "deny"
        or not isinstance(reason, str)
    ):
        return None
    return reason


def classify_outcome(
    returncode: int,
    stdout: str,
    *,
    exception: BaseException | None = None,
) -> tuple[str, str | None]:
    """Derive the telemetry decision without changing live hook output."""

    if exception is not None:
        detail = _sanitize_reason(exception)
        prefix = type(exception).__name__
        return "error", f"{prefix}: {detail}" if detail else prefix
    if returncode != 0:
        return "error", f"runner exited with status {returncode}"
    if stdout == "":
        return "allow", None
    reason = _deny_reason(stdout)
    if reason is not None:
        return "deny", reason
    return "error", "malformed tagged runner output"


def make_outcome(
    correlation_id: str,
    behavior: str,
    invocation: str,
    decision: str,
    reason: str | None,
    *,
    now: float | None = None,
) -> Outcome:
    if invocation not in _INVOCATIONS:
        raise ValueError(f"invalid invocation: {invocation}")
    if decision not in _DECISIONS:
        raise ValueError(f"invalid decision: {decision}")
    return {
        "correlation_id": correlation_id,
        "ts": time.time() if now is None else float(now),
        "behavior": behavior,
        "invocation": invocation,
        "decision": decision,
        "reason": reason,
    }


def _valid_outcome(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    return (
        isinstance(record.get("correlation_id"), str)
        and bool(record["correlation_id"])
        and isinstance(record.get("ts"), (int, float))
        and not isinstance(record.get("ts"), bool)
        and math.isfinite(record["ts"])
        and isinstance(record.get("behavior"), str)
        and bool(record["behavior"])
        and record.get("invocation") in _INVOCATIONS
        and record.get("decision") in _DECISIONS
        and (record.get("reason") is None or isinstance(record.get("reason"), str))
    )


def _valid_divergence(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    mismatches = record.get("mismatches")
    cc_hook = record.get("cc_hook")
    middleware = record.get("middleware")
    return (
        isinstance(record.get("correlation_id"), str)
        and bool(record["correlation_id"])
        and isinstance(record.get("ts"), (int, float))
        and not isinstance(record.get("ts"), bool)
        and math.isfinite(record["ts"])
        and isinstance(record.get("behavior"), str)
        and bool(record["behavior"])
        and record.get("signal") == "warden_double_enforcement_divergence"
        and isinstance(mismatches, list)
        and bool(mismatches)
        and all(item in _MISMATCHES for item in mismatches)
        and (cc_hook is None or _valid_outcome(cc_hook))
        and (middleware is None or _valid_outcome(middleware))
    )


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    """Append one complete JSONL record with one ``os.write`` call."""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        written = os.write(fd, payload)
        if written != len(payload):
            raise OSError(f"short append: wrote {written} of {len(payload)} bytes")
    finally:
        os.close(fd)


def _read_jsonl(path: Path, validator: Callable[[object], bool]) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if validator(record):
            records.append(record)
    return records


def read_outcomes(path: Path) -> list[Outcome]:
    return _read_jsonl(path, _valid_outcome)


def read_divergences(path: Path) -> list[dict[str, Any]]:
    return _read_jsonl(path, _valid_divergence)


def append_outcome(path: Path, record: Outcome) -> None:
    if not _valid_outcome(record):
        raise ValueError("invalid double-enforcement outcome")
    append_jsonl(path, record)


def _matching_primary(outcome_path: Path, correlation_id: str) -> Outcome | None:
    for record in reversed(read_outcomes(outcome_path)):
        if (
            record["correlation_id"] == correlation_id
            and record["invocation"] == "cc-hook"
        ):
            return record
    return None


def _append_divergence(
    divergence_path: Path,
    *,
    correlation_id: str,
    behavior: str,
    mismatches: list[str],
    cc_hook: Outcome | None,
    middleware: Outcome | None,
    now: float | None = None,
) -> dict[str, Any]:
    if not mismatches or any(item not in _MISMATCHES for item in mismatches):
        raise ValueError("invalid double-enforcement mismatch categories")
    record = {
        "correlation_id": correlation_id,
        "ts": time.time() if now is None else float(now),
        "behavior": behavior,
        "signal": "warden_double_enforcement_divergence",
        "mismatches": mismatches,
        "cc_hook": cc_hook,
        "middleware": middleware,
    }
    append_jsonl(divergence_path, record)
    return record


def compare_middleware_outcome(
    outcome_path: Path,
    divergence_path: Path,
    middleware: Outcome,
    *,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Compare one observer outcome to the newest matching primary."""

    if middleware.get("invocation") != "middleware" or not _valid_outcome(middleware):
        raise ValueError("comparison requires a valid middleware outcome")
    primary = _matching_primary(outcome_path, middleware["correlation_id"])
    mismatches: list[str] = []
    if primary is None:
        mismatches.append("missing_cc_hook")
    elif primary["decision"] != middleware["decision"]:
        mismatches.append("decision")
    elif primary["decision"] == "deny" and primary["reason"] != middleware["reason"]:
        mismatches.append("feedback")
    # Two error decisions agree categorically. Their diagnostic text is not
    # policy feedback and may differ for legitimate infrastructure reasons.
    if not mismatches:
        return None
    return _append_divergence(
        divergence_path,
        correlation_id=middleware["correlation_id"],
        behavior=middleware["behavior"],
        mismatches=mismatches,
        cc_hook=primary,
        middleware=middleware,
        now=now,
    )


@contextlib.contextmanager
def _reconciliation_lock(divergence_path: Path):
    """Serialize orphan read/dedup/append across concurrent tagged runs."""

    if fcntl is None:
        yield
        return
    divergence_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(divergence_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def reconcile_missing_middleware(
    outcome_path: Path,
    divergence_path: Path,
    *,
    now: float | None = None,
    orphan_after_seconds: float = ORPHAN_AFTER_SECONDS,
) -> list[dict[str, Any]]:
    """Append one divergence for each stale, unreconciled primary orphan."""

    current = time.time() if now is None else float(now)
    with _reconciliation_lock(divergence_path):
        outcomes = read_outcomes(outcome_path)
        middleware_cids = {
            record["correlation_id"]
            for record in outcomes
            if record["invocation"] == "middleware"
        }
        already_reported = {
            record["correlation_id"]
            for record in read_divergences(divergence_path)
            if "missing_middleware" in record["mismatches"]
        }
        stale_by_cid: dict[str, Outcome] = {}
        cutoff = current - orphan_after_seconds
        for record in outcomes:
            if record["invocation"] != "cc-hook" or record["ts"] > cutoff:
                continue
            cid = record["correlation_id"]
            if cid in middleware_cids or cid in already_reported:
                continue
            stale_by_cid[cid] = record

        emitted: list[dict[str, Any]] = []
        for cid, primary in stale_by_cid.items():
            emitted.append(
                _append_divergence(
                    divergence_path,
                    correlation_id=cid,
                    behavior=primary["behavior"],
                    mismatches=["missing_middleware"],
                    cc_hook=primary,
                    middleware=None,
                    now=current,
                )
            )
    return emitted


def record_secondary_launch_failure(
    outcome_path: Path,
    divergence_path: Path,
    *,
    correlation_id: str,
    behavior: str,
    error: BaseException,
    now: float | None = None,
) -> Outcome:
    reason = _sanitize_reason(error)
    prefix = type(error).__name__
    middleware = make_outcome(
        correlation_id,
        behavior,
        "middleware",
        "error",
        f"{prefix}: {reason}" if reason else prefix,
        now=now,
    )
    append_outcome(outcome_path, middleware)
    _append_divergence(
        divergence_path,
        correlation_id=correlation_id,
        behavior=behavior,
        mismatches=["secondary_launch"],
        cc_hook=_matching_primary(outcome_path, correlation_id),
        middleware=middleware,
        now=now,
    )
    return middleware


def launch_secondary(
    *,
    script_path: Path,
    behavior: str,
    event_json: str,
    correlation_id: str,
    repo_root: Path,
    workspace_root: Path,
    outcome_path: Path,
    divergence_path: Path,
    python_command: str | None = None,
    popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
) -> bool:
    """Start the observational runner in a detached process session."""

    command = [
        python_command or sys.executable,
        str(script_path),
        "run",
        behavior,
        "--correlation-id",
        correlation_id,
        "--invocation",
        "middleware",
        "--repo-root",
        str(repo_root),
        "--workspace-root",
        str(workspace_root),
    ]
    try:
        process = popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        if process.stdin is None:
            raise OSError("secondary stdin pipe was not created")
        process.stdin.write(event_json)
        process.stdin.close()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        record_secondary_launch_failure(
            outcome_path,
            divergence_path,
            correlation_id=correlation_id,
            behavior=behavior,
            error=exc,
        )
        return False
    return True
