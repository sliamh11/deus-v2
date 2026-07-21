"""Tests for LIA-453 log-to-issue (scripts/log_to_issue.py).

Hermetic: every test that touches state/lock/details files points the
module's path constants at a throwaway tmp_path tree via monkeypatch, and
`gh` is never actually invoked (dry_run=True routes create_issue/comment_issue/
reopen_issue through their `[DRY] ...` print branches instead of subprocess).
Nothing here touches the real ~/.config/deus-v2, ~/.config/deus, or the live
gh CLI. The v1/v2 path isolation is asserted where it actually lives — the
module-level path constants themselves.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

_MOD_PATH = Path(__file__).resolve().parents[1] / "log_to_issue.py"


def _load():
    spec = importlib.util.spec_from_file_location("log_to_issue", _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["log_to_issue"] = mod
    spec.loader.exec_module(mod)
    return mod


lti = _load()


# ── Isolation: v2 paths, never v1's ──────────────────────────────────────────


def test_all_four_state_paths_target_deus_v2_not_v1():
    """STATE_PATH/CONFIG_PATH/DETAILS_DIR/LOCK_PATH must all resolve under
    ~/.config/deus-v2 — never v1's ~/.config/deus. LOCK_PATH matters most:
    acquire_lock() exits 0 silently on contention, so a shared lock file
    would make v1's and v2's jobs silently no-op each other."""
    for name, path in (
        ("STATE_PATH", lti.STATE_PATH),
        ("CONFIG_PATH", lti.CONFIG_PATH),
        ("DETAILS_DIR", lti.DETAILS_DIR),
        ("LOCK_PATH", lti.LOCK_PATH),
    ):
        assert ".config" in path.parts and "deus-v2" in path.parts, name
        # Exact v1 dir must not appear as a path segment (not just "in the string").
        assert "deus" not in (p for p in path.parts if p != "deus-v2"), name


def test_log_path_targets_deus_v2_mvp_not_bare_deus():
    # "deus-v2-mvp" must be the repo-root directory component; the filename
    # itself ("deus.error.log") legitimately contains "deus" as its literal
    # name (matches setup/service.ts's logs/deus.error.log convention) — the
    # thing that must never be bare "deus" is the *directory* segment.
    assert "deus-v2-mvp" in lti.LOG_PATH.parts
    dir_parts = lti.LOG_PATH.parts[:-1]  # exclude the filename itself
    assert "deus" not in dir_parts


def test_repo_and_lock_path_are_v2_scoped():
    assert lti.REPO == "sliamh11/deus-v2"
    assert lti.LOCK_PATH == Path.home() / ".config/deus-v2/log_to_issue.lock"
    # Never v1's lock file — the exact collision the plan flags.
    assert lti.LOCK_PATH != Path.home() / ".config/deus/log_to_issue.lock"


# ── PII scrubbing ─────────────────────────────────────────────────────────────


def test_normalize_scrubs_phone_email_and_wa_jid():
    raw = "call +15551234567 or email a@b.com re 972501234567@s.whatsapp.net"
    out = lti.normalize(raw)
    assert "+15551234567" not in out
    assert "a@b.com" not in out
    assert "972501234567@s.whatsapp.net" not in out
    assert "<phone>" in out or "<wa-jid>" in out
    assert "<email>" in out


def test_normalize_scrubs_home_path_and_secrets():
    # Host-derived (not a hardcoded literal username) — the scrub pattern
    # itself is built from Path.home(), so this must pass on any host, not
    # just the one it was written on (LIA-453 code-review finding).
    home = str(Path.home())
    raw = f"at {home}/deus/src/x.ts token=sk-abcdefghijklmnopqrstuvwx"
    out = lti.normalize(raw)
    assert home not in out
    assert "sk-abcdefghijklmnopqrstuvwx" not in out
    assert out.startswith("at ~")


def test_home_path_scrub_pattern_is_host_derived_not_literal():
    """The PII-scrub pattern for the home directory must be built from
    Path.home(), never a hardcoded literal username — a literal would scrub
    nothing on any other host and would be a hardcoded-personal-path defect
    in this public repo (LIA-453 code-review finding)."""
    import re

    home_escaped = re.escape(str(lti.HOME))
    assert any(
        pattern.pattern.startswith(home_escaped) for pattern, _ in lti._PATTERNS
    ), "expected a _PATTERNS entry built from HOME, not a hardcoded literal"


def test_deep_drop_removes_content_keys_at_any_depth():
    # "message" is itself a _DROP_KEYS content key (dropped even inside
    # "err"), same as v1's script — event_from_pino relies on this exact
    # (wholesale-reused, unmodified) behavior, so err_msg is always derived
    # from a pre-drop `err.message` read done ahead of deep_drop, never from
    # the post-drop object. This test pins that shape rather than assuming
    # message content survives deep_drop.
    obj = {"msg": "ok", "err": {"message": "boom", "cause": {"body": "secret"}}}
    dropped = lti.deep_drop(obj)
    assert "cause" not in dropped["err"]
    assert "message" not in dropped["err"]
    assert dropped["msg"] == "ok"  # top-level "msg" is NOT a _DROP_KEYS entry


# ── err_type allowlist ────────────────────────────────────────────────────────


def test_safe_err_type_allows_known_and_masks_unknown(monkeypatch):
    monkeypatch.setattr(lti, "CONFIG_PATH", Path("/nonexistent/config.json"))
    assert lti.safe_err_type("TypeError") == "TypeError"
    assert lti.safe_err_type("SomeCustomInternalClass") == "UnknownError"
    assert lti.safe_err_type(None) == "UnknownError"


# ── Event extraction ──────────────────────────────────────────────────────────


def test_event_from_pino_filters_below_min_level():
    assert lti.event_from_pino({"level": 30, "msg": "info"}) is None


def test_event_from_pino_extracts_error():
    obj = {"level": 50, "time": 1700000000000, "err": {"type": "TypeError", "message": "x is not a function"}}
    ev = lti.event_from_pino(obj)
    assert ev is not None
    assert ev.fp_err_type == "TypeError"
    assert ev.wire_err_type == "TypeError"
    assert ev.source == "pino"
    assert ev.ts == 1700000000


def test_event_from_stderr_parses_error_line():
    lines = ["TypeError: cannot read x", "    at foo (file.js:1:1)"]
    ev = lti.event_from_stderr(lines)
    assert ev is not None
    assert ev.fp_err_type == "TypeError"
    assert ev.level == 50
    assert ev.top_frames


def test_event_from_stderr_fatal_bumps_level():
    ev = lti.event_from_stderr(["FATAL: unhandled rejection"])
    assert ev is not None
    assert ev.level == 60


# ── Fingerprint / dedupe ──────────────────────────────────────────────────────


def test_fingerprint_is_stable_and_deduped():
    ev1 = lti.event_from_stderr(["TypeError: boom", "    at a (x.js:1:1)"])
    ev2 = lti.event_from_stderr(["TypeError: boom", "    at a (x.js:1:1)"])
    assert lti.fingerprint(ev1) == lti.fingerprint(ev2)


def test_fingerprint_differs_on_message():
    ev1 = lti.event_from_stderr(["TypeError: boom"])
    ev2 = lti.event_from_stderr(["TypeError: kaboom"])
    assert lti.fingerprint(ev1) != lti.fingerprint(ev2)


# ── stream_events: rotation / bytes ───────────────────────────────────────────


def test_stream_events_missing_path_is_benign():
    events, offset, inode = lti.stream_events(Path("/nonexistent/log"), 0, 0)
    assert events == []


def test_stream_events_detects_rotation_and_rereads_from_zero(tmp_path: Path, capsys):
    log = tmp_path / "deus.error.log"
    log.write_text('{"level":50,"time":1700000000000,"err":{"type":"Error","message":"one"}}\n')
    st = log.stat()
    events, offset, inode = lti.stream_events(log, 0, 0)
    assert len(events) == 1
    # Simulate rotation: new inode-equivalent state (different start_inode) + smaller offset.
    events2, offset2, inode2 = lti.stream_events(log, inode + 1, offset + 1000)
    assert len(events2) == 1  # re-read from byte 0
    assert "rotation" in capsys.readouterr().err


# ── atomic_write / state round-trip ───────────────────────────────────────────


def test_atomic_write_and_state_roundtrip(tmp_path: Path, monkeypatch):
    state_path = tmp_path / "nested" / "state.json"
    monkeypatch.setattr(lti, "STATE_PATH", state_path)
    state = {"version": lti.STATE_VERSION, "cursor": {"inode": 0, "offset": 0, "path": "x"}, "bootstrapped_at": 0, "errors": {}}
    lti.save_state(state)
    assert state_path.exists()
    loaded = lti.load_state()
    assert loaded == state


def test_load_state_no_file_returns_fresh_default(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(lti, "STATE_PATH", tmp_path / "missing.json")
    s = lti.load_state()
    assert s["errors"] == {}
    assert s["version"] == lti.STATE_VERSION


# ── write_sidecar ──────────────────────────────────────────────────────────────


def test_write_sidecar_appends_samples_capped_at_ten(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(lti, "DETAILS_DIR", tmp_path / "details")
    ev = lti.event_from_stderr(["TypeError: boom"])
    for i in range(12):
        lti.write_sidecar("abc123", ev, i + 1)
    data = json.loads((tmp_path / "details" / "abc123.json").read_text())
    assert len(data["samples"]) == 10
    assert data["count"] == 12


# ── dry-run end-to-end via --fixture (no gh, no state writes) ────────────────


def test_run_with_fixture_is_always_dry_and_creates_no_state(tmp_path: Path, monkeypatch, capsys):
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(lti, "STATE_PATH", state_path)
    fixture = tmp_path / "fixture.log"
    fixture.write_text(
        '{"level":50,"time":1700000000000,"err":{"type":"TypeError","message":"boom one"}}\n'
        '{"level":30,"time":1700000000000,"msg":"ignored info"}\n'
        "RangeError: index out of bounds\n"
    )
    rc = lti.run(fixture=fixture, verbose=True)
    assert rc == 0
    assert not state_path.exists()  # fixture path never persists state
    out = capsys.readouterr().out
    assert "[DRY]" in out
    assert "TypeError" in out
    assert "RangeError" in out
    assert "ignored info" not in out  # level 30 filtered out


def test_run_bootstrap_sentinels_everything_without_creating_issues(tmp_path: Path, monkeypatch):
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(lti, "STATE_PATH", state_path)
    fixture = tmp_path / "fixture.log"
    fixture.write_text('{"level":50,"time":1700000000000,"err":{"type":"TypeError","message":"boom"}}\n')
    rc = lti.run(bootstrap=True, fixture=fixture)
    assert rc == 0


# ── acquire_lock: contended vs stale ──────────────────────────────────────────


def test_acquire_lock_writes_pid_file(tmp_path: Path, monkeypatch):
    lock_path = tmp_path / "log_to_issue.lock"
    monkeypatch.setattr(lti, "LOCK_PATH", lock_path)
    lti.acquire_lock()
    assert lock_path.exists()
    assert lock_path.read_text().strip().isdigit()


def test_acquire_lock_skips_when_stale_pid(tmp_path: Path, monkeypatch):
    lock_path = tmp_path / "log_to_issue.lock"
    # A PID that (almost certainly) does not exist on this host.
    lock_path.write_text("999999")
    monkeypatch.setattr(lti, "LOCK_PATH", lock_path)
    lti.acquire_lock()  # stale pid -> proceeds and overwrites with our own pid
    assert lock_path.read_text().strip().isdigit()
    assert lock_path.read_text().strip() != "999999"


def test_acquire_lock_exits_0_when_pid_alive(tmp_path: Path, monkeypatch):
    import os

    lock_path = tmp_path / "log_to_issue.lock"
    lock_path.write_text(str(os.getpid()))  # our own pid is definitely alive
    monkeypatch.setattr(lti, "LOCK_PATH", lock_path)
    try:
        lti.acquire_lock()
        raised = False
    except SystemExit as e:
        raised = True
        assert e.code == 0
    assert raised


# ── is_ignored ─────────────────────────────────────────────────────────────────


def test_is_ignored_matches_err_type_and_msg_contains():
    ev = lti.event_from_stderr(["TypeError: connection reset by peer"])
    assert lti.is_ignored(ev, [{"err_type_eq": "TypeError", "msg_contains": "connection reset"}])
    assert not lti.is_ignored(ev, [{"err_type_eq": "RangeError"}])


# ── reset_fingerprint ──────────────────────────────────────────────────────────


def test_reset_fingerprint_removes_entry_and_sidecar(tmp_path: Path, monkeypatch, capsys):
    state_path = tmp_path / "state.json"
    details_dir = tmp_path / "details"
    monkeypatch.setattr(lti, "STATE_PATH", state_path)
    monkeypatch.setattr(lti, "DETAILS_DIR", details_dir)
    state = {
        "version": lti.STATE_VERSION,
        "cursor": {"inode": 0, "offset": 0, "path": "x"},
        "bootstrapped_at": 0,
        "errors": {"fp1": {"issue_number": 1}},
    }
    lti.save_state(state)
    details_dir.mkdir(parents=True)
    (details_dir / "fp1.json").write_text("{}")

    rc = lti.reset_fingerprint("fp1")
    assert rc == 0
    assert "fp1" not in lti.load_state()["errors"]
    assert not (details_dir / "fp1.json").exists()


def test_reset_fingerprint_unknown_fp_errors(tmp_path: Path, monkeypatch):
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(lti, "STATE_PATH", state_path)
    lti.save_state({"version": lti.STATE_VERSION, "cursor": {"inode": 0, "offset": 0, "path": "x"}, "bootstrapped_at": 0, "errors": {}})
    assert lti.reset_fingerprint("nope") == 1
