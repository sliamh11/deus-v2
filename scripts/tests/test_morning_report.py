"""Tests for the morning memory report (scripts/maintenance/morning_report.py).

Hermetic: health/maintenance sources are fixture files under tmp_path, the
control-group DB is a throwaway sqlite file, and delivery is an injected
recorder — nothing shells out, no Ollama, no real chat. The IPC delivery
contract is asserted against the same shape the in-process watcher validates
(IpcMessageFileSchema: {type, chatJid?, text?}).
"""
from __future__ import annotations

import importlib.util
import json
import types
import sqlite3
import sys
from pathlib import Path

_MOD_PATH = (
    Path(__file__).resolve().parents[1] / "maintenance" / "morning_report.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("morning_report", _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["morning_report"] = mod
    spec.loader.exec_module(mod)
    return mod


mr = _load()

NOW = 1_750_000_000.0  # fixed epoch seconds for deterministic ts/date


def _health(**kw) -> dict:
    base = {"date": "2026-06-24", "atoms": 2949, "avg_confidence": 0.702,
            "sessions": 811, "entities": 1513, "articles": 324, "articles_stale": 50}
    base.update(kw)
    return base


# ── _read_health ──────────────────────────────────────────────────────────────

def test_read_health_latest_and_prev(tmp_path: Path):
    p = tmp_path / "h.jsonl"
    p.write_text("\n".join(json.dumps(o) for o in [
        _health(date="2026-06-22", atoms=2900),
        _health(date="2026-06-23", atoms=2940),
        _health(date="2026-06-24", atoms=2949),
    ]))
    latest, prev = mr._read_health(p)
    assert latest["atoms"] == 2949 and prev["atoms"] == 2940  # last two only


def test_read_health_recovers_prev_past_malformed_tail(tmp_path: Path):
    # A corrupted trailing line must NOT drop the valid previous snapshot (the
    # overnight delta would silently vanish). Scan-from-end skips it.
    p = tmp_path / "h.jsonl"
    p.write_text(
        json.dumps(_health(date="2026-06-23", atoms=2900)) + "\n"
        + json.dumps(_health(date="2026-06-24", atoms=2940)) + "\n"
        + "{truncated write\n"
    )
    latest, prev = mr._read_health(p)
    assert latest["atoms"] == 2940 and prev["atoms"] == 2900


def test_read_health_missing_file(tmp_path: Path):
    assert mr._read_health(tmp_path / "nope.jsonl") == (None, None)


def test_read_health_skips_malformed(tmp_path: Path):
    p = tmp_path / "h.jsonl"
    p.write_text("{bad json\n" + json.dumps(_health()) + "\n")
    latest, prev = mr._read_health(p)
    assert latest["atoms"] == 2949 and prev is None


# ── _parse_last_maintenance_run ─────────────────────────────────────────────────

_LOG = """\
=== Deus maintenance — 2026-06-23 04:30 ===

── Daily ──
  [memory_gc] OK
  [health] OK
=== Done: 5 OK, 0 failed ===

=== Deus maintenance — 2026-06-24 04:30 ===

── Daily ──
  [memory_gc] OK
  [credential_probe] running...
    [codex] WARN — only 8min to expiry (refresher stalled?)
    credential_probe: 2 OK, 0 WARN, 0 skipped
  [credential_probe] FAILED (exit 1)
  [health] OK
── Weekly ──
  [judge_calibration] running...
    [WARN] quality Pearson 0.40 < 0.580 floor — local judge calibration REGRESSION
  [judge_calibration] FAILED (exit 1)
=== Done: 4 OK, 2 failed ===
"""


def test_parse_last_run_only_last_block(tmp_path: Path):
    p = tmp_path / "maintenance.log"
    p.write_text(_LOG)
    m = mr._parse_last_maintenance_run(p)
    assert m["ran"] is True
    assert "2026-06-24" in m["header"]
    assert set(m["failed"]) == {"credential_probe", "judge_calibration"}
    assert m["ok"] == 4
    # WARN/REGRESSION lines surfaced
    assert any("expiry" in w for w in m["warns"])
    assert any("REGRESSION" in w for w in m["warns"])
    # ...but a healthy count-summary ("2 OK, 0 WARN, 0 skipped") is NOT a warning.
    assert not any("skipped" in w for w in m["warns"])


def test_parse_missing_log(tmp_path: Path):
    assert mr._parse_last_maintenance_run(tmp_path / "nope.log") is None


# ── _format_digest ──────────────────────────────────────────────────────────────

def test_format_digest_deltas_and_warns():
    latest = _health(atoms=2949, avg_confidence=0.702)
    prev = _health(date="2026-06-23", atoms=2940, avg_confidence=0.690)
    maint = {"ran": True, "ok": 4, "failed": ["credential_probe"],
             "warns": ["[codex] WARN — only 8min to expiry"], "done": "Done: 4 OK, 1 failed"}
    out = mr._format_digest(latest, prev, maint, "2026-06-24")
    assert "+9" in out  # atom delta 2949-2940
    assert "+0.012" in out  # confidence delta
    assert "1 failed: credential_probe" in out
    assert "⚠️" in out and "expiry" in out


def test_format_digest_stale_snapshot_flagged():
    latest = _health(date="2026-06-22")  # older than 'today'
    out = mr._format_digest(latest, None, {"ran": True, "ok": 5, "failed": [], "warns": []}, "2026-06-24")
    assert "2026-06-22" in out and "no fresh" in out


def test_format_digest_no_data_fallbacks():
    out = mr._format_digest(None, None, None, "2026-06-24")
    assert "no health snapshot" in out and "no overnight run" in out


# ── _find_control_group ─────────────────────────────────────────────────────────

def _make_db(tmp_path: Path, *, with_main: bool) -> Path:
    db = tmp_path / "messages.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE registered_groups (folder TEXT, jid TEXT, is_main INTEGER)")
    con.execute("INSERT INTO registered_groups VALUES ('other','other@g.us',0)")
    if with_main:
        con.execute("INSERT INTO registered_groups VALUES ('main','main@g.us',1)")
    con.commit()
    con.close()
    return db


def test_find_control_group_present(tmp_path: Path):
    assert mr._find_control_group(_make_db(tmp_path, with_main=True)) == ("main", "main@g.us")


def test_find_control_group_absent(tmp_path: Path):
    assert mr._find_control_group(_make_db(tmp_path, with_main=False)) is None


def test_find_control_group_missing_db(tmp_path: Path):
    assert mr._find_control_group(tmp_path / "nope.db") is None


# ── _deliver ────────────────────────────────────────────────────────────────────

def test_deliver_writes_schema_valid_ipc_file(tmp_path: Path):
    ok = mr._deliver(tmp_path, "main", "main@g.us", "hello\nworld", ts=123)
    assert ok is True
    files = list((tmp_path / "ipc" / "main" / "messages").glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text())
    # IpcMessageFileSchema contract: type required; chatJid/text the carried fields.
    assert payload["type"] == "message"
    assert payload["chatJid"] == "main@g.us"
    assert payload["text"] == "hello\nworld"


def test_deliver_rejects_path_traversal_folder(tmp_path: Path):
    # Defense-in-depth: a folder that could escape data/ipc/ is refused, no write.
    assert mr._deliver(tmp_path, "../../etc", "j@g.us", "x", ts=1) is False
    assert not (tmp_path / "ipc").exists()


# ── main (injected deliverer/notifier) ──────────────────────────────────────────

class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        return True


def _setup_sources(tmp_path: Path, *, with_main=True, cockpit: "Path | None" = None):
    health = tmp_path / "h.jsonl"
    health.write_text(json.dumps(_health(date="2026-06-24")) + "\n")
    log = tmp_path / "maintenance.log"
    log.write_text(_LOG)
    db = _make_db(tmp_path, with_main=with_main)
    # --cockpit is always pinned to tmp: without it these tests read the real
    # ~/.deus/cockpit_health.json off the developer's machine, which makes them
    # depend on live state (the LIA-555 lesson, one repo over).
    return ["--health", str(health), "--maint-log", str(log),
            "--db", str(db), "--data-dir", str(tmp_path / "data"),
            "--cockpit", str(cockpit or tmp_path / "no-cockpit.json")]


def test_main_delivers_to_control_group(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: False)
    argv = _setup_sources(tmp_path, with_main=True)
    deliver = _Recorder()
    code = mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW)
    assert code == 0
    assert len(deliver.calls) == 1
    data_dir, folder, jid, text, ts = deliver.calls[0]
    assert folder == "main" and jid == "main@g.us"
    assert "While you slept" in text


def test_main_no_control_group_skips_and_notifies(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: False)
    argv = _setup_sources(tmp_path, with_main=False)
    deliver, notify = _Recorder(), _Recorder()
    code = mr.main(argv=argv, deliverer=deliver, notifier=notify, now=NOW)
    assert code == 0
    assert deliver.calls == []        # no chat delivery
    assert len(notify.calls) == 1     # desktop fallback instead


def test_main_no_data_is_benign_skip(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: False)
    argv = ["--health", str(tmp_path / "nope.jsonl"),
            "--maint-log", str(tmp_path / "nope.log"),
            "--db", str(tmp_path / "nope.db"), "--data-dir", str(tmp_path / "data"),
            "--cockpit", str(tmp_path / "nope.json")]
    deliver = _Recorder()
    code = mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW)
    assert code == 0
    assert deliver.calls == []


# ── cockpit verdict (LIA-552) ───────────────────────────────────────────────────
#
# The recurring theme: an absent verdict must be reported where one was expected,
# and silent where none ever was. Three plan-review rounds each found a different
# layer where that distinction had been dropped.


def _cockpit(status="OK", probe="evolution.optimizer", *, regression=True,
             observed="python3 cannot import dspy", checked_at=NOW, n_ok=0):
    probes = [{"probe": f"ok{i}", "status": "OK", "observed": "", "is_regression": False}
              for i in range(n_ok)]
    if status != "OK":
        probes.append({"probe": probe, "status": status, "observed": observed,
                       "is_regression": regression})
    return {"checked_at": checked_at, "probes": probes}


def _write_cockpit(tmp_path: Path, payload) -> Path:
    p = tmp_path / "cockpit.json"
    p.write_text(json.dumps(payload) if not isinstance(payload, str) else payload)
    return p


def test_read_cockpit_returns_the_verdict(tmp_path: Path):
    assert mr._read_cockpit(_write_cockpit(tmp_path, _cockpit()))["checked_at"] == NOW


def test_read_cockpit_missing_file(tmp_path: Path):
    assert mr._read_cockpit(tmp_path / "absent.json") is None


def test_read_cockpit_malformed_json(tmp_path: Path):
    """A corrupt artifact must not take down the whole morning report."""
    assert mr._read_cockpit(_write_cockpit(tmp_path, "{not json")) is None


def test_read_cockpit_non_dict(tmp_path: Path):
    assert mr._read_cockpit(_write_cockpit(tmp_path, "[1,2,3]")) is None


def test_cockpit_all_ok_is_one_line():
    out = mr._format_digest(None, None, None, "2026-06-24", _cockpit(n_ok=6), True, NOW)
    assert "Systems: all OK (6 probes)" in out


def test_cockpit_failure_shows_status_probe_and_evidence():
    out = mr._format_digest(None, None, None, "2026-06-24",
                            _cockpit(status="FAILED"), True, NOW)
    assert "FAILED" in out and "evolution.optimizer" in out
    assert "cannot import dspy" in out and "NEW" in out


def test_cockpit_ongoing_failure_is_not_marked_new():
    out = mr._format_digest(None, None, None, "2026-06-24",
                            _cockpit(status="FAILED", regression=False), True, NOW)
    assert "ONGOING" in out and "NEW" not in out


def test_cockpit_unknown_is_distinguishable_from_failed():
    """The cockpit treats UNKNOWN (partial blindness) as different from FAILED;
    collapsing both to 'not OK' would discard that."""
    out = mr._format_digest(None, None, None, "2026-06-24",
                            _cockpit(status="UNKNOWN", observed="OPA unreachable"),
                            True, NOW)
    assert "UNKNOWN" in out and "FAILED" not in out


def test_cockpit_stale_verdict_warns_even_when_every_probe_says_ok():
    """Where trusting the content alone misleads: all probes OK, but the verdict
    predates the run that should have refreshed it."""
    out = mr._format_digest(None, None, None, "2026-06-24",
                            _cockpit(n_ok=3, checked_at=NOW - (31 * 3600)), True, NOW)
    assert "31h old" in out and "may not be running" in out


def test_cockpit_25h_old_does_not_warn():
    """Pins the cadence-sized 30h threshold against a future 'just reuse 36h'."""
    out = mr._format_digest(None, None, None, "2026-06-24",
                            _cockpit(n_ok=3, checked_at=NOW - (25 * 3600)), True, NOW)
    assert "may not be running" not in out


def test_missing_verdict_is_reported_when_one_was_expected():
    out = mr._format_digest(None, None, None, "2026-06-24", None, True, NOW)
    assert "no cockpit verdict on record" in out


def test_no_cockpit_section_at_all_when_never_installed():
    """An install that never enabled the cockpit must not be told daily that its
    verdict is missing."""
    out = mr._format_digest(_health(date="2026-06-24"), None, None, "2026-06-24",
                            None, False, NOW)
    assert "cockpit" not in out.lower()
    assert "Memory:" in out, "the rest of the digest is unaffected"


def test_existing_positional_calls_are_unchanged():
    """The three pre-existing callers pass four positional args; the defaults
    must leave their output byte-identical."""
    a = mr._format_digest(_health(date="2026-06-24"), None, None, "2026-06-24")
    b = mr._format_digest(_health(date="2026-06-24"), None, None, "2026-06-24",
                          None, False, NOW)
    assert a == b


def test_main_delivers_the_cockpit_section(tmp_path: Path, monkeypatch):
    """Without this the feature is inert: the parameter exists, nothing passes
    it, and the digest never carries the section."""
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: True)
    cp = _write_cockpit(tmp_path, _cockpit(status="FAILED"))
    argv = _setup_sources(tmp_path, with_main=True, cockpit=cp)
    deliver = _Recorder()

    assert mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW) == 0
    text = deliver.calls[0][3]
    assert "evolution.optimizer" in text and "FAILED" in text


def test_a_cockpit_only_signal_still_reaches_delivery(tmp_path: Path, monkeypatch):
    """The no-data early return fires before formatting, so a FAILED probe must
    not be dropped just because health and maintenance happen to be absent."""
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: True)
    cp = _write_cockpit(tmp_path, _cockpit(status="FAILED"))
    db = _make_db(tmp_path, with_main=True)
    argv = ["--health", str(tmp_path / "none.jsonl"), "--maint-log", str(tmp_path / "none.log"),
            "--db", str(db), "--data-dir", str(tmp_path / "data"), "--cockpit", str(cp)]
    deliver = _Recorder()

    assert mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW) == 0
    assert deliver.calls, "a cockpit-only signal must not be swallowed"
    assert "evolution.optimizer" in deliver.calls[0][3]


def test_a_missing_but_expected_verdict_still_reaches_delivery(tmp_path: Path, monkeypatch):
    """Gating the skip on `cockpit is None` would exit precisely when the verdict
    is missing — the one case that most needs reporting."""
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: True)
    db = _make_db(tmp_path, with_main=True)
    argv = ["--health", str(tmp_path / "none.jsonl"), "--maint-log", str(tmp_path / "none.log"),
            "--db", str(db), "--data-dir", str(tmp_path / "data"),
            "--cockpit", str(tmp_path / "absent.json")]
    deliver = _Recorder()

    assert mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW) == 0
    assert deliver.calls, "an expected-but-missing verdict is news, not silence"
    assert "no cockpit verdict on record" in deliver.calls[0][3]


def test_a_fresh_install_still_stays_quiet(tmp_path: Path, monkeypatch):
    """The guard's actual purpose, pinned so a future edit cannot turn it into a
    noise source: nothing configured, nothing expected, nothing sent."""
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: False)
    argv = ["--health", str(tmp_path / "none.jsonl"), "--maint-log", str(tmp_path / "none.log"),
            "--db", str(tmp_path / "none.db"), "--data-dir", str(tmp_path / "data"),
            "--cockpit", str(tmp_path / "absent.json")]
    deliver, notify = _Recorder(), _Recorder()

    assert mr.main(argv=argv, deliverer=deliver, notifier=notify, now=NOW) == 0
    assert deliver.calls == [] and notify.calls == []


def test_read_cockpit_rejects_malformed_fields(tmp_path: Path):
    """Top-level dict is not enough. This artifact crosses a process boundary
    (written by cockpit_healthcheck.py in another repo), and a string timestamp
    or a non-list probes value would raise straight out of the formatter and
    kill the unattended daily report."""
    for bad in ({"checked_at": "yesterday", "probes": []},
                {"checked_at": NOW, "probes": 5},
                {"probes": []},
                {"checked_at": NOW}):
        p = tmp_path / "bad.json"
        p.write_text(json.dumps(bad))
        assert mr._read_cockpit(p) is None, f"should reject {bad!r}"


def test_a_malformed_artifact_cannot_kill_the_report(tmp_path: Path, monkeypatch):
    """End to end: a corrupt verdict degrades to the missing-verdict warning,
    it does not raise. The report runs unattended — a crash here is silence."""
    monkeypatch.setattr(mr, "_cockpit_expected", lambda: True)
    bad = tmp_path / "cockpit.json"
    bad.write_text(json.dumps({"checked_at": "not-a-number", "probes": "nope"}))
    db = _make_db(tmp_path, with_main=True)
    argv = ["--health", str(tmp_path / "none.jsonl"), "--maint-log", str(tmp_path / "none.log"),
            "--db", str(db), "--data-dir", str(tmp_path / "data"), "--cockpit", str(bad)]
    deliver = _Recorder()

    assert mr.main(argv=argv, deliverer=deliver, notifier=_Recorder(), now=NOW) == 0
    assert "no cockpit verdict on record" in deliver.calls[0][3]


def test_a_garbage_probe_entry_cannot_manufacture_all_ok(tmp_path: Path):
    """A non-dict entry is skipped when collecting failures but would still be
    counted in the "all OK (N probes)" total — turning garbage into a clean
    verdict. Reject the artifact instead."""
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"checked_at": NOW,
                             "probes": [{"probe": "a", "status": "OK"}, "junk", 42]}))
    assert mr._read_cockpit(p) is None

    out = mr._format_digest(None, None, None, "2026-06-24", mr._read_cockpit(p), True, NOW)
    assert "all OK" not in out
    assert "no cockpit verdict on record" in out


def test_a_probe_missing_keys_does_not_render_none(tmp_path: Path):
    """Literal "None" in a delivered WhatsApp message is a bug, not a status."""
    out = mr._format_digest(None, None, None, "2026-06-24",
                            {"checked_at": NOW, "probes": [{"status": "FAILED"}]},
                            True, NOW)
    assert "None" not in out
    assert "<unnamed probe>" in out and "no detail recorded" in out


def test_cockpit_is_expected_on_every_platform_it_installs_on(tmp_path, monkeypatch):
    """setup installs this job via launchd, systemd AND Task Scheduler. Checking
    only the macOS plist would silently omit every verdict — failures included —
    on supported Linux and Windows installs."""
    launchd = tmp_path / "com.deus.cockpit-healthcheck.plist"
    systemd_user = tmp_path / "deus-cockpit-healthcheck.timer"
    systemd_root = tmp_path / "etc-deus-cockpit-healthcheck.timer"
    monkeypatch.setattr(mr, "COCKPIT_JOB_MARKERS", (launchd, systemd_user, systemd_root))
    monkeypatch.setattr(mr.sys, "platform", "linux")

    assert mr._cockpit_expected() is False, "nothing installed"
    systemd_user.write_text("[Unit]")
    assert mr._cockpit_expected() is True, "a systemd timer must count"

    systemd_user.unlink()
    systemd_root.write_text("[Unit]")
    assert mr._cockpit_expected() is True, "a root systemd timer must count"

    systemd_root.unlink()
    launchd.write_text("<plist/>")
    assert mr._cockpit_expected() is True, "a launchd plist must count"


def test_windows_falls_back_to_task_scheduler(tmp_path, monkeypatch):
    monkeypatch.setattr(mr, "COCKPIT_JOB_MARKERS", (tmp_path / "absent",))
    monkeypatch.setattr(mr.sys, "platform", "win32")

    monkeypatch.setattr(mr.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(returncode=0))
    assert mr._cockpit_expected() is True

    monkeypatch.setattr(mr.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(returncode=1))
    assert mr._cockpit_expected() is False

    def boom(*a, **k):
        raise OSError("schtasks missing")
    monkeypatch.setattr(mr.subprocess, "run", boom)
    assert mr._cockpit_expected() is False, "cannot tell -> do not warn daily"
