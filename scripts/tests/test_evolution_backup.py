"""Tests for LIA-453 evolution DB backup (scripts/evolution_backup.py).

Hermetic: every test builds a throwaway DB + backups tree under pytest's
tmp_path, so nothing touches the real ~/.deus-v2 or ~/.deus. The v1/v2 path
isolation is asserted where it actually lives — in the script's path resolvers.
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

_MOD_PATH = Path(__file__).resolve().parents[1] / "evolution_backup.py"


def _load():
    spec = importlib.util.spec_from_file_location("evolution_backup", _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["evolution_backup"] = mod
    spec.loader.exec_module(mod)
    return mod


eb = _load()


# ── Isolation: v2 paths, never v1's ──────────────────────────────────────────


def test_default_db_targets_deus_v2_not_v1(monkeypatch):
    """With no override/env, the source must resolve under ~/.deus-v2 — never the
    v1 ~/.deus path (the silent cross-write hazard evolution/config.py warns of)."""
    monkeypatch.delenv("DEUS_EVOLUTION_DB", raising=False)
    p = eb.resolve_db_path()
    assert p == (Path.home() / ".deus-v2" / "evolution.db")
    assert ".deus-v2" in p.parts
    assert ".deus" not in p.parts  # exact v1 dir must not appear as a path segment


def test_env_override_wins(monkeypatch):
    monkeypatch.setenv("DEUS_EVOLUTION_DB", "~/custom/evo.db")
    assert eb.resolve_db_path() == (Path.home() / "custom" / "evo.db")
    # Explicit --db arg beats the env var.
    assert eb.resolve_db_path("/tmp/x.db") == Path("/tmp/x.db")


def test_dest_dir_is_beside_db_under_deus_v2():
    db = Path.home() / ".deus-v2" / "evolution.db"
    dest = eb.resolve_dest_dir(db)
    assert dest == (Path.home() / ".deus-v2" / "backups" / "evolution")
    # Never v1's backups tree.
    assert dest != (Path.home() / ".deus" / "backups" / "evolution")


# ── Backup + prune behaviour ─────────────────────────────────────────────────


def test_backup_copies_db_to_dated_snapshot(tmp_path: Path):
    db = tmp_path / "evolution.db"
    db.write_bytes(b"sqlite-ish-bytes")
    dest = eb.resolve_dest_dir(db)
    snap = eb.backup(db, dest, dry_run=False, verbose=False)
    assert snap is not None and snap.exists()
    assert snap.name.startswith("evolution-") and snap.name.endswith(".db")
    assert snap.read_bytes() == b"sqlite-ish-bytes"


def test_missing_db_is_benign_skip(tmp_path: Path):
    db = tmp_path / "nope.db"  # never created
    dest = eb.resolve_dest_dir(db)
    assert eb.backup(db, dest, dry_run=False, verbose=False) is None
    # main() returns 0 (not a scheduler failure) on the benign skip.
    assert eb.main(["--db", str(db)]) == 0


def test_dry_run_writes_nothing(tmp_path: Path):
    db = tmp_path / "evolution.db"
    db.write_bytes(b"x")
    dest = eb.resolve_dest_dir(db)
    eb.backup(db, dest, dry_run=True, verbose=False)
    assert not dest.exists()


def test_prune_deletes_only_older_than_keep_days(tmp_path: Path):
    dest = tmp_path / "backups" / "evolution"
    dest.mkdir(parents=True)
    old = dest / "evolution-2020-01-01.db"
    recent = dest / "evolution-2020-01-08.db"
    for f in (old, recent):
        f.write_bytes(b"x")
    now = time.time()
    import os

    os.utime(old, (now - 10 * 86400, now - 10 * 86400))  # 10 days old
    os.utime(recent, (now - 1 * 86400, now - 1 * 86400))  # 1 day old
    deleted = eb.prune(dest, keep_days=7, dry_run=False, verbose=False)
    assert deleted == 1
    assert not old.exists()
    assert recent.exists()


def test_prune_ignores_the_live_db_and_sidecars(tmp_path: Path):
    dest = tmp_path / "backups" / "evolution"
    dest.mkdir(parents=True)
    # A stray non-snapshot file must never be pruned by the age sweep.
    stray = dest / "evolution.db-wal"
    stray.write_bytes(b"x")
    import os

    os.utime(stray, (0, 0))  # ancient
    assert eb.prune(dest, keep_days=7, dry_run=False, verbose=False) == 0
    assert stray.exists()


def test_main_full_run_snapshots_and_prunes(tmp_path: Path):
    db = tmp_path / "evolution.db"
    db.write_bytes(b"x")
    dest = eb.resolve_dest_dir(db)
    dest.mkdir(parents=True)
    stale = dest / "evolution-2019-01-01.db"
    stale.write_bytes(b"x")
    import os

    os.utime(stale, (0, 0))
    assert eb.main(["--db", str(db), "--keep-days", "7"]) == 0
    assert not stale.exists()  # pruned
    assert any(
        p.name.startswith("evolution-") and p != stale for p in dest.glob("*.db")
    )
