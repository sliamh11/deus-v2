"""Tests for LIA-453 v2 healthcheck supervisor (scripts/healthcheck.py).

Hermetic: every test builds a throwaway config/sentinel/heartbeat tree under
pytest's tmp_path, and subprocess (launchctl/osascript) is mocked — nothing
touches the real ~/.config/deus-v2 or ~/.config/deus. The v1/v2 sentinel
isolation is asserted where it actually lives — in the script's default
constant and its resolve_sentinel_path() resolver.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

_MOD_PATH = Path(__file__).resolve().parents[1] / "healthcheck.py"


def _load():
    spec = importlib.util.spec_from_file_location("healthcheck", _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["healthcheck"] = mod
    spec.loader.exec_module(mod)
    return mod


hc = _load()


def _launchctl_result(rows: list) -> object:
    """Build a fake subprocess.CompletedProcess-like object for `launchctl list`.

    rows: list of (pid_str, exit_str, label) tuples, "-" for pid means not running.
    """
    header = "PID\tStatus\tLabel"
    lines = [header] + ["\t".join(r) for r in rows]

    class _Result:
        stdout = "\n".join(lines)

    return _Result()


# ── Isolation: v2 config/sentinel paths, never v1's ─────────────────────────


def test_default_config_targets_deus_v2_not_v1(monkeypatch):
    """With no override/env, the config must resolve under ~/.config/deus-v2 —
    never v1's ~/.config/deus path."""
    monkeypatch.delenv("DEUS_V2_HEALTHCHECK_CONFIG", raising=False)
    p = hc.resolve_config_path()
    assert p == (Path.home() / ".config" / "deus-v2" / "healthcheck.json")
    assert "deus-v2" in p.parts
    assert p.parts.count("deus") == 0


def test_config_env_override_wins(monkeypatch):
    monkeypatch.setenv("DEUS_V2_HEALTHCHECK_CONFIG", "~/custom/hc.json")
    assert hc.resolve_config_path() == (Path.home() / "custom" / "hc.json")
    # Explicit --config arg beats the env var.
    assert hc.resolve_config_path("/tmp/x.json") == Path("/tmp/x.json")


def test_default_sentinel_is_v2_scoped_never_v1s_path():
    """The core LIA-453 plan-review finding: an empty/omitted notify config
    must NOT fall back onto v1's ~/.config/deus/HEALTH_ALERT.json."""
    sentinel = hc.resolve_sentinel_path({})
    assert sentinel == (Path.home() / ".config" / "deus-v2" / "HEALTH_ALERT.json")
    v1_sentinel = Path.home() / ".config" / "deus" / "HEALTH_ALERT.json"
    assert sentinel != v1_sentinel
    assert "deus-v2" in sentinel.parts


def test_sentinel_config_override_is_still_honored():
    sentinel = hc.resolve_sentinel_path({"sentinel_path": "~/somewhere/else.json"})
    assert sentinel == (Path.home() / "somewhere" / "else.json")


def test_default_sentinel_constant_itself_is_v2_scoped():
    """Regression guard directly on the module constant (not just the
    resolver) — the exact class of bug the plan-review caught: a v1-scoped
    literal string surviving a copy-paste."""
    assert "deus-v2" in hc.DEFAULT_SENTINEL_PATH
    assert hc.DEFAULT_SENTINEL_PATH != "~/.config/deus/HEALTH_ALERT.json"


# ── check_loaded_and_running ─────────────────────────────────────────────────


def test_loaded_and_running_ok_when_pid_positive():
    job = {"label": "com.deus-v2"}
    rows = [("12345", "0", "com.deus-v2")]
    with patch.object(hc.subprocess, "run", return_value=_launchctl_result(rows)):
        ok, detail = hc.check_loaded_and_running(job)
    assert ok is True
    assert "pid=12345" in detail


def test_loaded_and_running_fails_when_not_loaded():
    job = {"label": "com.deus-v2.healthcheck"}
    with patch.object(hc.subprocess, "run", return_value=_launchctl_result([])):
        ok, detail = hc.check_loaded_and_running(job)
    assert ok is False
    assert "not loaded" in detail


def test_loaded_and_running_fails_when_loaded_but_not_running():
    job = {"label": "com.deus-v2.log-review"}
    rows = [("-", "1", "com.deus-v2.log-review")]
    with patch.object(hc.subprocess, "run", return_value=_launchctl_result(rows)):
        ok, detail = hc.check_loaded_and_running(job)
    assert ok is False
    assert "loaded but not running" in detail
    assert "exit code=1" in detail


def test_loaded_and_running_fails_on_pid_zero():
    job = {"label": "com.deus-v2.maintenance"}
    rows = [("0", "0", "com.deus-v2.maintenance")]
    with patch.object(hc.subprocess, "run", return_value=_launchctl_result(rows)):
        ok, detail = hc.check_loaded_and_running(job)
    assert ok is False
    assert "PID=0" in detail


# ── check_heartbeat ───────────────────────────────────────────────────────────


def test_heartbeat_ok_when_fresh(tmp_path: Path):
    hb = tmp_path / "maintenance.log"
    hb.write_text("x")
    job = {"heartbeat_path": str(hb), "max_staleness_sec": 108000}
    ok, detail = hc.check_heartbeat(job)
    assert ok is True
    assert "old" in detail


def test_heartbeat_fails_when_stale(tmp_path: Path):
    import os

    hb = tmp_path / "stale.log"
    hb.write_text("x")
    old = time.time() - 200000
    os.utime(hb, (old, old))
    job = {"heartbeat_path": str(hb), "max_staleness_sec": 108000}
    ok, detail = hc.check_heartbeat(job)
    assert ok is False
    assert "old (>" in detail


def test_heartbeat_fails_when_missing(tmp_path: Path):
    job = {"heartbeat_path": str(tmp_path / "nope.log"), "max_staleness_sec": 100}
    ok, detail = hc.check_heartbeat(job)
    assert ok is False
    assert "missing" in detail


# ── check_heartbeat_glob ──────────────────────────────────────────────────────


def test_heartbeat_glob_ok_uses_newest_match(tmp_path: Path):
    import os

    old_snap = tmp_path / "evolution-2020-01-01.db"
    new_snap = tmp_path / "evolution-2020-01-08.db"
    old_snap.write_text("x")
    new_snap.write_text("x")
    now = time.time()
    os.utime(old_snap, (now - 200000, now - 200000))
    os.utime(new_snap, (now - 10, now - 10))
    job = {
        "heartbeat_glob": str(tmp_path / "evolution-*.db"),
        "max_staleness_sec": 108000,
    }
    ok, detail = hc.check_heartbeat_glob(job)
    assert ok is True
    assert "evolution-2020-01-08.db" in detail


def test_heartbeat_glob_fails_when_no_matches(tmp_path: Path):
    job = {
        "heartbeat_glob": str(tmp_path / "nothing-*.db"),
        "max_staleness_sec": 100,
    }
    ok, detail = hc.check_heartbeat_glob(job)
    assert ok is False
    assert "no files match" in detail


def test_heartbeat_glob_fails_when_newest_is_stale(tmp_path: Path):
    import os

    snap = tmp_path / "evolution-2020-01-01.db"
    snap.write_text("x")
    old = time.time() - 200000
    os.utime(snap, (old, old))
    job = {
        "heartbeat_glob": str(tmp_path / "evolution-*.db"),
        "max_staleness_sec": 108000,
    }
    ok, detail = hc.check_heartbeat_glob(job)
    assert ok is False
    assert "old (>" in detail


# ── run_checks / sentinel + notify wiring ────────────────────────────────────


def test_run_checks_reports_ok_and_failing_jobs(tmp_path: Path):
    hb = tmp_path / "fresh.log"
    hb.write_text("x")
    jobs = [
        {
            "label": "com.deus-v2.maintenance",
            "check": "heartbeat",
            "heartbeat_path": str(hb),
            "max_staleness_sec": 108000,
        },
        {
            "label": "com.deus-v2.log-to-issue",
            "check": "heartbeat",
            "heartbeat_path": str(tmp_path / "missing.json"),
            "max_staleness_sec": 1800,
        },
    ]
    results, failures = hc.run_checks(jobs)
    assert any(r.startswith("[OK] com.deus-v2.maintenance") for r in results)
    assert any(r.startswith("[FAIL] com.deus-v2.log-to-issue") for r in results)
    assert len(failures) == 1
    assert failures[0]["label"] == "com.deus-v2.log-to-issue"


def test_run_checks_skips_unknown_check_type():
    jobs = [{"label": "com.deus-v2.weird", "check": "not-a-real-check"}]
    results, failures = hc.run_checks(jobs)
    assert any("[SKIP]" in r and "unknown check" in r for r in results)
    assert failures == []


def test_run_checks_treats_raised_exception_as_failure(tmp_path: Path):
    # heartbeat check requires "heartbeat_path" — omitting it raises KeyError,
    # which must be caught and reported as a failure, not crash the run.
    jobs = [{"label": "com.deus-v2.broken", "check": "heartbeat"}]
    results, failures = hc.run_checks(jobs)
    assert len(failures) == 1
    assert "check raised" in failures[0]["detail"]


def test_write_and_clear_sentinel_roundtrip(tmp_path: Path):
    sentinel = tmp_path / "nested" / "HEALTH_ALERT.json"
    failures = [{"label": "com.deus-v2.x", "description": "", "check": "heartbeat", "detail": "stale"}]
    hc.write_sentinel(sentinel, failures)
    assert sentinel.exists()
    data = json.loads(sentinel.read_text())
    assert data["failing_count"] == 1
    assert data["failures"] == failures

    hc.clear_sentinel(sentinel)
    assert not sentinel.exists()


def test_clear_sentinel_is_noop_when_absent(tmp_path: Path):
    sentinel = tmp_path / "never-existed.json"
    hc.clear_sentinel(sentinel)  # must not raise
    assert not sentinel.exists()


# ── main() end-to-end ─────────────────────────────────────────────────────────


def test_main_missing_config_returns_2(tmp_path: Path, capsys):
    missing = tmp_path / "nope.json"
    rc = hc.main(["--config", str(missing)])
    assert rc == 2
    assert "missing config" in capsys.readouterr().err


def test_main_all_ok_clears_sentinel_and_returns_0(tmp_path: Path):
    hb = tmp_path / "fresh.log"
    hb.write_text("x")
    sentinel = tmp_path / "HEALTH_ALERT.json"
    sentinel.write_text("{}")  # pre-existing sentinel from a prior failure

    cfg = {
        "jobs": [
            {
                "label": "com.deus-v2.maintenance",
                "check": "heartbeat",
                "heartbeat_path": str(hb),
                "max_staleness_sec": 108000,
            }
        ],
        "notify": {"sentinel_path": str(sentinel), "macos_banner": True},
    }
    config_path = tmp_path / "healthcheck.json"
    config_path.write_text(json.dumps(cfg))

    with patch.object(hc, "notify_macos") as mock_notify:
        rc = hc.main(["--config", str(config_path)])

    assert rc == 0
    assert not sentinel.exists()
    mock_notify.assert_not_called()


def test_main_failure_writes_sentinel_and_notifies(tmp_path: Path):
    sentinel = tmp_path / "HEALTH_ALERT.json"
    cfg = {
        "jobs": [
            {
                "label": "com.deus-v2.log-to-issue",
                "check": "heartbeat",
                "heartbeat_path": str(tmp_path / "missing.json"),
                "max_staleness_sec": 1800,
            }
        ],
        "notify": {"sentinel_path": str(sentinel), "macos_banner": True},
    }
    config_path = tmp_path / "healthcheck.json"
    config_path.write_text(json.dumps(cfg))

    with patch.object(hc, "notify_macos") as mock_notify:
        rc = hc.main(["--config", str(config_path)])

    assert rc == 1
    assert sentinel.exists()
    data = json.loads(sentinel.read_text())
    assert data["failing_count"] == 1
    mock_notify.assert_called_once()
    summary, body = mock_notify.call_args[0]
    assert "1 job(s) failing" == summary
    # Body strips the v2 label prefix, never a v1 one.
    assert body == "log-to-issue"


def test_main_failure_skips_notify_when_banner_disabled(tmp_path: Path):
    sentinel = tmp_path / "HEALTH_ALERT.json"
    cfg = {
        "jobs": [
            {
                "label": "com.deus-v2.log-to-issue",
                "check": "heartbeat",
                "heartbeat_path": str(tmp_path / "missing.json"),
                "max_staleness_sec": 1800,
            }
        ],
        "notify": {"sentinel_path": str(sentinel), "macos_banner": False},
    }
    config_path = tmp_path / "healthcheck.json"
    config_path.write_text(json.dumps(cfg))

    with patch.object(hc, "notify_macos") as mock_notify:
        rc = hc.main(["--config", str(config_path)])

    assert rc == 1
    assert sentinel.exists()
    mock_notify.assert_not_called()


def test_main_uses_default_sentinel_when_notify_config_omits_it(tmp_path: Path):
    """End-to-end guard: a config that (like a careless copy of v1's) forgets
    to set notify.sentinel_path must still land on a v2-scoped path, not
    silently fall through to v1's HEALTH_ALERT.json. write_sentinel/clear_sentinel
    are mocked so this never touches the real filesystem default."""
    cfg = {
        "jobs": [
            {
                "label": "com.deus-v2.log-to-issue",
                "check": "heartbeat",
                "heartbeat_path": str(tmp_path / "missing.json"),
                "max_staleness_sec": 1800,
            }
        ],
        "notify": {"macos_banner": False},
    }
    config_path = tmp_path / "healthcheck.json"
    config_path.write_text(json.dumps(cfg))

    v1_sentinel = Path("~/.config/deus/HEALTH_ALERT.json").expanduser()

    with patch.object(hc, "notify_macos"), patch.object(hc, "write_sentinel") as mock_write:
        rc = hc.main(["--config", str(config_path)])

    assert rc == 1
    mock_write.assert_called_once()
    sentinel_arg = mock_write.call_args[0][0]
    assert sentinel_arg == Path(hc.DEFAULT_SENTINEL_PATH).expanduser()
    assert sentinel_arg != v1_sentinel
    assert "deus-v2" in sentinel_arg.parts
