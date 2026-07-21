#!/usr/bin/env python3
"""
Deus-v2 healthcheck supervisor (LIA-453).

Cross-platform, in-repo replacement for v1's out-of-repo
`~/.config/deus/scripts/healthcheck.py`. Reads
`~/.config/deus-v2/healthcheck.json`, probes each `com.deus-v2*` job, and on
failure:
  1. fires a macOS notification banner
  2. writes/updates a v2-scoped alert sentinel (cleared when the fleet
     recovers)

Check types (identical mechanism to v1's script, re-pointed at v2 labels/paths):
  loaded_and_running  — launchctl list shows label + PID > 0
  heartbeat           — stat(path).mtime newer than max_staleness_sec
  heartbeat_glob      — newest glob match stat.mtime newer than threshold

Isolation (LIA-453 plan-review finding): v1's script defaults the alert
sentinel to `~/.config/deus/HEALTH_ALERT.json` unless the config overrides
`notify.sentinel_path` — and v1's own config always does override it, so
copying v1's script wholesale would leave v2 defaulting onto v1's file the
moment v2's config omits that key, silently clobbering the sentinel v1's own
`/resume` catch-up hook reads. This script's DEFAULT_SENTINEL_PATH is
`~/.config/deus-v2/HEALTH_ALERT.json` — a v2-scoped default that can never
collide with v1's, config override or not.

Usage:
    python3 scripts/healthcheck.py                  # read default v2 config, run once
    python3 scripts/healthcheck.py --config /path.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# LIA-453: v2-namespaced config path — never v1's ~/.config/deus/healthcheck.json.
DEFAULT_CONFIG_PATH = "~/.config/deus-v2/healthcheck.json"
_ENV_CONFIG = "DEUS_V2_HEALTHCHECK_CONFIG"

# LIA-453 plan-review finding: this default MUST be v2-scoped. A reused
# ~/.config/deus/HEALTH_ALERT.json default here would silently overwrite/clear
# v1's alert sentinel the moment a v2 config omits notify.sentinel_path.
DEFAULT_SENTINEL_PATH = "~/.config/deus-v2/HEALTH_ALERT.json"

_LABEL_PREFIX = "com.deus-v2."


def expand(p: str) -> Path:
    return Path(os.path.expanduser(p))


def resolve_config_path(override: "str | None" = None) -> Path:
    """--config > $DEUS_V2_HEALTHCHECK_CONFIG > packaged v2-scoped default."""
    raw = override or os.environ.get(_ENV_CONFIG) or DEFAULT_CONFIG_PATH
    return Path(raw).expanduser()


def resolve_sentinel_path(notify_cfg: dict) -> Path:
    """The alert sentinel file. Config's notify.sentinel_path wins; otherwise
    falls back to DEFAULT_SENTINEL_PATH — never v1's path, by construction."""
    raw = notify_cfg.get("sentinel_path", DEFAULT_SENTINEL_PATH)
    return expand(raw)


def launchctl_row(label: str) -> "tuple[int | None, int | None]":
    """Return (pid, last_exit_code). pid is None if not loaded."""
    r = subprocess.run(
        ["launchctl", "list"],
        capture_output=True, text=True, timeout=10,
    )
    for line in r.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) >= 3 and parts[2].strip() == label:
            pid = None if parts[0].strip() == "-" else int(parts[0].strip())
            try:
                exit_code = int(parts[1].strip())
            except ValueError:
                exit_code = None
            return pid, exit_code
    return None, None


def check_loaded_and_running(job: dict) -> "tuple[bool, str]":
    pid, exit_code = launchctl_row(job["label"])
    if pid is None and exit_code is None:
        return False, "not loaded in launchctl"
    if pid is None:
        return False, f"loaded but not running (last exit code={exit_code})"
    if pid <= 0:
        return False, f"PID=0 (last exit code={exit_code})"
    return True, f"running pid={pid}"


def check_heartbeat(job: dict) -> "tuple[bool, str]":
    path = expand(job["heartbeat_path"])
    max_stale = int(job["max_staleness_sec"])
    if not path.exists():
        return False, f"heartbeat path missing: {path}"
    age = time.time() - path.stat().st_mtime
    if age > max_stale:
        return False, f"heartbeat {int(age)}s old (> {max_stale}s)"
    return True, f"heartbeat {int(age)}s old"


def check_heartbeat_glob(job: dict) -> "tuple[bool, str]":
    pattern = os.path.expanduser(job["heartbeat_glob"])
    max_stale = int(job["max_staleness_sec"])
    matches = glob.glob(pattern)
    if not matches:
        return False, f"no files match: {pattern}"
    newest = max(matches, key=lambda p: os.path.getmtime(p))
    age = time.time() - os.path.getmtime(newest)
    if age > max_stale:
        return False, f"newest {os.path.basename(newest)} {int(age)}s old (> {max_stale}s)"
    return True, f"newest {os.path.basename(newest)} {int(age)}s old"


CHECKS = {
    "loaded_and_running": check_loaded_and_running,
    "heartbeat": check_heartbeat,
    "heartbeat_glob": check_heartbeat_glob,
}


def notify_macos(summary: str, body: str) -> None:
    safe_sum = summary.replace('"', "'")
    safe_body = body.replace('"', "'")
    script = (
        f'display notification "{safe_body}" '
        f'with title "Deus-v2 Healthcheck" '
        f'subtitle "{safe_sum}" sound name "Basso"'
    )
    subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, timeout=10,
    )


def write_sentinel(sentinel_path: Path, failures: list) -> None:
    sentinel_path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "checked_at": int(time.time()),
        "failing_count": len(failures),
        "failures": failures,
    }
    sentinel_path.write_text(json.dumps(data, indent=2, sort_keys=True))


def clear_sentinel(sentinel_path: Path) -> None:
    if sentinel_path.exists():
        sentinel_path.unlink()


def run_checks(jobs: list) -> "tuple[list[str], list[dict]]":
    """Run every job's check. Returns (result lines, failure dicts)."""
    failures = []
    results = []
    for job in jobs:
        check_type = job.get("check", "loaded_and_running")
        fn = CHECKS.get(check_type)
        if fn is None:
            results.append(f"[SKIP] {job['label']}: unknown check {check_type!r}")
            continue
        try:
            ok, detail = fn(job)
        except Exception as e:
            ok, detail = False, f"check raised: {e}"
        tag = "OK" if ok else "FAIL"
        results.append(f"[{tag}] {job['label']}: {detail}")
        if not ok:
            failures.append({
                "label": job["label"],
                "description": job.get("description", ""),
                "check": check_type,
                "detail": detail,
            })
    return results, failures


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(description="Deus-v2 healthcheck supervisor")
    parser.add_argument("--config", default=None, help="override config path")
    args = parser.parse_args(argv)

    config_path = resolve_config_path(args.config)
    if not config_path.exists():
        print(f"missing config: {config_path}", file=sys.stderr)
        return 2
    cfg = json.loads(config_path.read_text())
    jobs = cfg.get("jobs", [])
    notify_cfg = cfg.get("notify", {})
    sentinel_path = resolve_sentinel_path(notify_cfg)

    results, failures = run_checks(jobs)

    for line in results:
        print(line)

    if failures:
        write_sentinel(sentinel_path, failures)
        if notify_cfg.get("macos_banner", True):
            summary = f"{len(failures)} job(s) failing"
            body = ", ".join(f["label"].replace(_LABEL_PREFIX, "") for f in failures)
            notify_macos(summary, body)
        return 1

    clear_sentinel(sentinel_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
