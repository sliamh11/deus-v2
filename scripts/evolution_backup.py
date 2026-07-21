#!/usr/bin/env python3
"""
Deus-v2 evolution DB backup (LIA-453).

Daily snapshot of the evolution database with age-based retention. This is the
cross-platform, in-repo replacement for v1's inline-bash `com.deus.evolution-backup`
launchd job — routed through the generic SCHEDULED_JOBS registry in
setup/service.ts so it gets macOS launchd / Linux systemd-timer / Windows
schtasks scheduling for free (a plist/timer/task named `com.deus-v2.evolution-backup`
/ `deus-v2-evolution-backup` / `DeusV2EvolutionBackup`).

Isolation: the source DB defaults to the SAME env-resolved path evolution/config.py
uses (`DEUS_EVOLUTION_DB`, default `~/.deus-v2/evolution.db`), so this can never
silently snapshot v1's `~/.deus/evolution.db`. Backups land in a `backups/evolution/`
directory beside the DB (i.e. `~/.deus-v2/backups/evolution/`), never in v1's tree.

Retention mirrors v1's `find ... -mtime +7 -delete`: keep the last --keep-days
days of snapshots, prune older ones. Best-effort — a single unlink failure never
aborts the run.

Fresh install with no DB yet → benign skip + exit 0 (mirrors morning_report.py's
benign-skip contract) so the scheduler's error log isn't polluted before the
evolution system has written anything.

Usage:
    python3 scripts/evolution_backup.py                 # snapshot + prune (7d)
    python3 scripts/evolution_backup.py --keep-days 14  # keep two weeks
    python3 scripts/evolution_backup.py --dry-run        # preview, no writes
    python3 scripts/evolution_backup.py --db /path.db    # override source DB
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import time
from datetime import date
from pathlib import Path

# LIA-453: byte-for-byte the default in evolution/config.py:35 so the two
# resolve identically. Leaving it on v1's ~/.deus path would snapshot the wrong
# instance's data — the exact silent-cross-write hazard config.py warns about.
DEFAULT_DB = "~/.deus-v2/evolution.db"
_ENV_DB = "DEUS_EVOLUTION_DB"

# A snapshot is "evolution-YYYY-MM-DD.db". The date anchor keeps this from ever
# matching the live DB (evolution.db) or a sqlite -wal/-shm sidecar.
_SNAPSHOT_RE = re.compile(r"^evolution-\d{4}-\d{2}-\d{2}\.db$")


def resolve_db_path(override: str | None = None) -> Path:
    """The evolution DB to back up. --db > $DEUS_EVOLUTION_DB > packaged default."""
    raw = override or os.environ.get(_ENV_DB) or DEFAULT_DB
    return Path(raw).expanduser()


def resolve_dest_dir(db_path: Path) -> Path:
    """`backups/evolution/` beside the DB — e.g. ~/.deus-v2/backups/evolution/."""
    return db_path.parent / "backups" / "evolution"


def prune(dest_dir: Path, keep_days: int, dry_run: bool, verbose: bool) -> int:
    """Delete snapshots older than keep_days (by mtime). Returns count deleted.

    Best-effort: a concurrent unlink or permission error on one file never
    aborts the sweep."""
    if keep_days <= 0 or not dest_dir.is_dir():
        return 0
    cutoff = time.time() - keep_days * 86400
    deleted = 0
    for f in dest_dir.glob("evolution-*.db"):
        if not (f.is_file() and _SNAPSHOT_RE.match(f.name)):
            continue
        try:
            if f.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        if dry_run:
            if verbose:
                print(f"  [prune] would delete {f.name}")
            deleted += 1
            continue
        try:
            f.unlink()
            deleted += 1
            if verbose:
                print(f"  [prune] deleted {f.name}")
        except OSError as e:
            print(f"  [prune] skip {f.name}: {e}", file=sys.stderr)
    return deleted


def backup(
    db_path: Path, dest_dir: Path, dry_run: bool, verbose: bool
) -> "Path | None":
    """Copy the DB to dest_dir/evolution-<today>.db. Returns the snapshot path,
    or None on a benign skip (no source DB yet)."""
    if not db_path.is_file():
        print(f"evolution_backup: no DB at {db_path} yet — nothing to back up")
        return None
    snapshot = dest_dir / f"evolution-{date.today().isoformat()}.db"
    if dry_run:
        print(f"evolution_backup: would copy {db_path} -> {snapshot}")
        return snapshot
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(db_path, snapshot)
    if verbose:
        print(f"evolution_backup: wrote {snapshot}")
    return snapshot


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(description="Deus-v2 evolution DB backup")
    parser.add_argument("--db", default=None, help="override source DB path")
    parser.add_argument(
        "--keep-days", type=int, default=7, help="retention window (default 7)"
    )
    parser.add_argument("--dry-run", action="store_true", help="preview, no writes")
    parser.add_argument("--verbose", action="store_true", help="per-file logging")
    args = parser.parse_args(argv)

    db_path = resolve_db_path(args.db)
    dest_dir = resolve_dest_dir(db_path)

    snapshot = backup(db_path, dest_dir, args.dry_run, args.verbose)
    if snapshot is None:
        # Benign skip: fresh install, no DB written yet. Not a scheduler failure.
        return 0

    deleted = prune(dest_dir, args.keep_days, args.dry_run, args.verbose)
    verb = "would prune" if args.dry_run else "pruned"
    print(
        f"evolution_backup: {'would snapshot' if args.dry_run else 'snapshot'} "
        f"{snapshot.name}; {verb} {deleted} old backup(s) (keep {args.keep_days}d)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
