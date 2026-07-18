"""Tests for scripts/transcript_archive.py (LIA-374 rank-1).

Content-addressed cold-source retention: archive session transcripts to
~/.deus/archive/transcripts/<sha256>.jsonl.zst so lossy /compress summaries
keep a decompress-back-to-source path. Best-effort mode never blocks.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent.parent
_NATIVE_FIXTURE = _ROOT / "scripts/tests/fixtures/deus_native_transcript_v1.jsonl"


def _load(name: str):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, _ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ta = _load("transcript_archive")


@pytest.fixture
def store(tmp_path, monkeypatch):
    d = tmp_path / "archive"
    monkeypatch.setenv("DEUS_TRANSCRIPT_ARCHIVE_DIR", str(d))
    return d


@pytest.fixture
def transcript(tmp_path):
    t = tmp_path / "session.jsonl"
    t.write_text('{"type":"user","text":"hello"}\n{"type":"assistant"}\n', encoding="utf-8")
    return t


class TestArchive:
    def test_content_addressed_and_idempotent(self, store, transcript):
        r1 = ta.archive(transcript)
        assert r1["ok"] is True
        dest1 = Path(r1["dest"])
        assert dest1.exists()
        assert dest1.name.startswith(r1["sha256"])
        mtime = dest1.stat().st_mtime
        r2 = ta.archive(transcript)  # second call: skip, same dest
        assert r2["ok"] is True and r2["dest"] == r1["dest"]
        assert Path(r2["dest"]).stat().st_mtime == mtime
        assert r2["skipped"] is True

    def test_sha_changes_with_content(self, store, transcript, tmp_path):
        r1 = ta.archive(transcript)
        other = tmp_path / "other.jsonl"
        other.write_text("different\n", encoding="utf-8")
        r2 = ta.archive(other)
        assert r1["sha256"] != r2["sha256"]

    def test_roundtrip_byte_equality(self, store, transcript):
        r = ta.archive(transcript)
        restored = ta.decompress(Path(r["dest"]))
        assert restored == transcript.read_bytes()

    def test_gzip_fallback_when_zstd_missing(self, store, transcript, monkeypatch):
        monkeypatch.setattr(ta, "_zstd_bin", lambda: None)
        r = ta.archive(transcript)
        assert r["ok"] is True
        assert r["dest"].endswith(".jsonl.gz")
        assert ta.decompress(Path(r["dest"])) == transcript.read_bytes()

    def test_best_effort_never_raises_on_missing_transcript(self, store, tmp_path):
        r = ta.archive(tmp_path / "nope.jsonl", best_effort=True)
        assert r["ok"] is False and "error" in r

    def test_strict_mode_raises_on_missing_transcript(self, store, tmp_path):
        with pytest.raises(FileNotFoundError):
            ta.archive(tmp_path / "nope.jsonl")


class TestResolve:
    def test_resolves_via_session_registry(self, tmp_path, monkeypatch):
        sessions = tmp_path / "sessions"
        projects = tmp_path / "projects"
        sessions.mkdir()
        cwd = "/Users/x/proj"
        slug = cwd.replace("/", "-")
        tdir = projects / slug
        tdir.mkdir(parents=True)
        (tdir / "sess-1.jsonl").write_text("{}\n", encoding="utf-8")
        (sessions / "123.json").write_text(
            json.dumps({"pid": 123, "sessionId": "sess-1", "cwd": cwd}), encoding="utf-8"
        )
        monkeypatch.setattr(ta, "_sessions_dir", lambda: sessions)
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        assert ta.resolve_transcript(cwd) == tdir / "sess-1.jsonl"

    def test_falls_back_to_newest_jsonl(self, tmp_path, monkeypatch):
        import os
        import time

        sessions = tmp_path / "sessions"
        projects = tmp_path / "projects"
        sessions.mkdir()
        cwd = "/Users/x/proj"
        tdir = projects / cwd.replace("/", "-")
        tdir.mkdir(parents=True)
        old = tdir / "old.jsonl"
        new = tdir / "new.jsonl"
        old.write_text("{}\n", encoding="utf-8")
        new.write_text("{}\n", encoding="utf-8")
        stale = time.time() - 1000
        os.utime(old, (stale, stale))
        monkeypatch.setattr(ta, "_sessions_dir", lambda: sessions)  # no registry match
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        assert ta.resolve_transcript(cwd) == new

    def test_claude_session_id_wins_over_registry_and_mtime(
        self, tmp_path, monkeypatch
    ):
        # Concurrent same-cwd sessions: CLAUDE_SESSION_ID must pin OUR
        # transcript even when a sibling session's file is newer / registered.
        sessions = tmp_path / "sessions"
        projects = tmp_path / "projects"
        sessions.mkdir()
        cwd = "/Users/x/proj"
        tdir = projects / cwd.replace("/", "-")
        tdir.mkdir(parents=True)
        (tdir / "ours.jsonl").write_text("{}\n", encoding="utf-8")
        (tdir / "sibling.jsonl").write_text("{}\n", encoding="utf-8")
        (sessions / "9.json").write_text(
            json.dumps({"pid": 9, "sessionId": "sibling", "cwd": cwd}),
            encoding="utf-8",
        )
        monkeypatch.setattr(ta, "_sessions_dir", lambda: sessions)
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        monkeypatch.setenv("CLAUDE_SESSION_ID", "ours")
        assert ta.resolve_transcript(cwd) == tdir / "ours.jsonl"
        monkeypatch.delenv("CLAUDE_SESSION_ID")
        assert ta.resolve_transcript(cwd) == tdir / "sibling.jsonl"

    def test_dotted_cwd_segments_encode_to_dashes(self, tmp_path, monkeypatch):
        # Claude Code slugs map '.' to '-' as well: /x/.claude/wt -> -x--claude-wt.
        sessions = tmp_path / "sessions"
        projects = tmp_path / "projects"
        sessions.mkdir()
        cwd = "/x/.claude/worktrees/wt-1"
        tdir = projects / "-x--claude-worktrees-wt-1"
        tdir.mkdir(parents=True)
        (tdir / "s.jsonl").write_text("{}\n", encoding="utf-8")
        monkeypatch.setattr(ta, "_sessions_dir", lambda: sessions)
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        assert ta.resolve_transcript(cwd) == tdir / "s.jsonl"

    def test_returns_none_when_nothing_found(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ta, "_sessions_dir", lambda: tmp_path / "s")
        monkeypatch.setattr(ta, "_projects_dir", lambda: tmp_path / "p")
        assert ta.resolve_transcript("/no/such/cwd") is None


class TestNativeResolve:
    def _native(self, tmp_path, session_id="native-session-001"):
        root = tmp_path / "native"
        path = ta.native_transcript_path(
            session_id, native_transcripts_dir=root
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_NATIVE_FIXTURE, path)
        return root, path

    def test_explicit_backend_and_session_find_hashed_native_file(
        self, tmp_path, store, capsys
    ):
        root, path = self._native(tmp_path)
        rc = ta.main(
            [
                "--backend",
                "deus-native",
                "--session-id",
                "native-session-001",
                "--native-transcripts-dir",
                str(root),
                "--json",
            ]
        )
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert result["ok"] is True
        assert ta.decompress(Path(result["dest"])) == path.read_bytes()

    def test_explicit_directory_override_is_honored(self, tmp_path):
        root, path = self._native(tmp_path)
        assert ta.resolve_native_transcript(
            "native-session-001", native_transcripts_dir=root
        ) == path

    def test_native_archive_preserves_raw_fixture_bytes_and_sha(self, tmp_path, store):
        _, path = self._native(tmp_path)
        result = ta.archive(path)
        assert result["sha256"] == __import__("hashlib").sha256(path.read_bytes()).hexdigest()
        assert ta.decompress(Path(result["dest"])) == _NATIVE_FIXTURE.read_bytes()

    def test_missing_native_session_best_effort_keeps_clean_shape(
        self, tmp_path, store, capsys
    ):
        rc = ta.main(
            [
                "--backend",
                "deus-native",
                "--session-id",
                "missing",
                "--native-transcripts-dir",
                str(tmp_path / "native"),
                "--best-effort",
                "--json",
            ]
        )
        assert rc == 0
        assert json.loads(capsys.readouterr().out) == {
            "ok": False,
            "error": "no deus-native transcript found for session missing",
        }


class TestAutoResolve:
    def _claude_tree(self, tmp_path, monkeypatch, cwd="/Users/x/proj"):
        sessions = tmp_path / "sessions"
        projects = tmp_path / "projects"
        sessions.mkdir(exist_ok=True)
        slug = cwd.replace("/", "-")
        directory = projects / slug
        directory.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(ta, "_sessions_dir", lambda: sessions)
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        return cwd, sessions, directory

    def _native(self, tmp_path, session_id):
        root = tmp_path / "native"
        path = ta.native_transcript_path(session_id, native_transcripts_dir=root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'{{"session":"{session_id}"}}\n')
        return root, path

    def test_explicit_session_beats_both_environment_ids_and_registry(
        self, tmp_path, monkeypatch
    ):
        cwd, sessions, claude_dir = self._claude_tree(tmp_path, monkeypatch)
        root, explicit = self._native(tmp_path, "explicit")
        self._native(tmp_path, "native-env")
        (claude_dir / "claude-env.jsonl").write_text("claude env\n")
        (claude_dir / "registry.jsonl").write_text("registry\n")
        (sessions / "1.json").write_text(
            json.dumps({"cwd": cwd, "sessionId": "registry"})
        )
        monkeypatch.setenv("DEUS_NATIVE_SESSION_ID", "native-env")
        monkeypatch.setenv("CLAUDE_SESSION_ID", "claude-env")
        assert ta.resolve_auto_transcript(
            cwd=cwd, session_id="explicit", native_transcripts_dir=root
        ) == explicit

    def test_deus_environment_beats_claude_environment_and_registry(
        self, tmp_path, monkeypatch
    ):
        cwd, sessions, claude_dir = self._claude_tree(tmp_path, monkeypatch)
        root, native = self._native(tmp_path, "native-env")
        (claude_dir / "claude-env.jsonl").write_text("claude env\n")
        (claude_dir / "registry.jsonl").write_text("registry\n")
        (sessions / "1.json").write_text(
            json.dumps({"cwd": cwd, "sessionId": "registry"})
        )
        monkeypatch.setenv("DEUS_NATIVE_SESSION_ID", "native-env")
        monkeypatch.setenv("CLAUDE_SESSION_ID", "claude-env")
        assert ta.resolve_auto_transcript(
            cwd=cwd, session_id=None, native_transcripts_dir=root
        ) == native

    def test_claude_environment_beats_registry(self, tmp_path, monkeypatch):
        cwd, sessions, claude_dir = self._claude_tree(tmp_path, monkeypatch)
        claude = claude_dir / "claude-env.jsonl"
        claude.write_text("claude env\n")
        (claude_dir / "registry.jsonl").write_text("registry\n")
        (sessions / "1.json").write_text(
            json.dumps({"cwd": cwd, "sessionId": "registry"})
        )
        monkeypatch.delenv("DEUS_NATIVE_SESSION_ID", raising=False)
        monkeypatch.setenv("CLAUDE_SESSION_ID", "claude-env")
        assert ta.resolve_auto_transcript(
            cwd=cwd, session_id=None, native_transcripts_dir=tmp_path / "native"
        ) == claude

    def test_registry_wins_without_environment_ids(self, tmp_path, monkeypatch):
        cwd, sessions, claude_dir = self._claude_tree(tmp_path, monkeypatch)
        registry = claude_dir / "registry.jsonl"
        registry.write_text("registry\n")
        (sessions / "1.json").write_text(
            json.dumps({"cwd": cwd, "sessionId": "registry"})
        )
        monkeypatch.delenv("DEUS_NATIVE_SESSION_ID", raising=False)
        monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)
        assert ta.resolve_auto_transcript(
            cwd=cwd, session_id=None, native_transcripts_dir=tmp_path / "native"
        ) == registry

    def test_same_explicit_id_in_both_stores_is_ambiguous_and_backend_disambiguates(
        self, tmp_path, monkeypatch, store, capsys
    ):
        cwd, _, claude_dir = self._claude_tree(tmp_path, monkeypatch)
        root, native = self._native(tmp_path, "same")
        claude = claude_dir / "same.jsonl"
        claude.write_text("claude\n")
        rc = ta.main(
            [
                "--cwd",
                cwd,
                "--session-id",
                "same",
                "--native-transcripts-dir",
                str(root),
                "--json",
            ]
        )
        assert rc == 1
        assert "both deus-native and Claude" in json.loads(capsys.readouterr().out)["error"]

        assert ta.resolve_native_transcript("same", native_transcripts_dir=root) == native
        assert ta.resolve_claude_transcript(cwd, session_id="same") == claude


class TestCli:
    def test_json_best_effort_exit_zero_on_error(self, store, tmp_path, capsys):
        rc = ta.main(["--transcript", str(tmp_path / "nope.jsonl"), "--json", "--best-effort"])
        assert rc == 0
        out = json.loads(capsys.readouterr().out)
        assert out["ok"] is False

    def test_json_happy_path(self, store, transcript, capsys):
        rc = ta.main(["--transcript", str(transcript), "--json"])
        assert rc == 0
        out = json.loads(capsys.readouterr().out)
        assert out["ok"] is True and out["sha256"] and out["dest"]

    def test_missing_transcript_without_best_effort_is_clean_error(
        self, store, tmp_path, capsys
    ):
        # Both CLI branches must degrade identically — no raw traceback.
        rc = ta.main(["--transcript", str(tmp_path / "nope.jsonl")])
        assert rc == 1
        assert "transcript not found" in capsys.readouterr().err

    @pytest.mark.parametrize(
        ("backend", "source_args"),
        [
            ("claude", ["--transcript", "{explicit}"]),
            ("claude", ["--cwd", "/Users/x/proj"]),
            (
                "claude",
                ["--cwd", "/Users/x/proj", "--session-id", "claude-id"],
            ),
            ("deus-native", ["--transcript", "{explicit}"]),
            ("deus-native", ["--session-id", "native-id"]),
            ("deus-native", ["--cwd", "/Users/x/proj"]),
            ("auto", ["--transcript", "{explicit}"]),
            ("auto", ["--cwd", "/Users/x/proj"]),
            ("auto", ["--cwd", "/Users/x/proj", "--session-id", "claude-id"]),
            ("auto", ["--session-id", "native-id"]),
        ],
    )
    def test_frozen_valid_argument_matrix(
        self,
        backend,
        source_args,
        tmp_path,
        monkeypatch,
        store,
        capsys,
    ):
        explicit = tmp_path / "explicit.jsonl"
        explicit.write_text("explicit\n")
        native_root = tmp_path / "native"
        native = ta.native_transcript_path(
            "native-id", native_transcripts_dir=native_root
        )
        native.parent.mkdir(parents=True)
        native.write_text("native\n")

        projects = tmp_path / "projects"
        claude_dir = projects / "-Users-x-proj"
        claude_dir.mkdir(parents=True)
        (claude_dir / "claude-id.jsonl").write_text("claude\n")
        monkeypatch.setattr(ta, "_projects_dir", lambda: projects)
        monkeypatch.setattr(ta, "_sessions_dir", lambda: tmp_path / "sessions")
        monkeypatch.setenv("DEUS_NATIVE_SESSION_ID", "native-id")

        args = [
            "--backend",
            backend,
            *[value.format(explicit=str(explicit)) for value in source_args],
            "--native-transcripts-dir",
            str(native_root),
            "--json",
        ]
        assert ta.main(args) == 0
        assert json.loads(capsys.readouterr().out)["ok"] is True

    @pytest.mark.parametrize(
        "args",
        [
            ["--backend", "claude"],
            ["--backend", "claude", "--session-id", "id"],
            ["--backend", "deus-native"],
            [
                "--backend",
                "deus-native",
                "--cwd",
                "/x",
                "--session-id",
                "id",
            ],
            ["--backend", "auto"],
            ["--transcript", "/x", "--session-id", "id"],
        ],
    )
    def test_frozen_invalid_argument_matrix_uses_clean_parser_errors(
        self, args, monkeypatch
    ):
        monkeypatch.delenv("DEUS_NATIVE_SESSION_ID", raising=False)
        with pytest.raises(SystemExit) as error:
            ta.main(args)
        assert error.value.code == 2

    def test_native_cwd_without_environment_id_is_invalid(self, monkeypatch):
        monkeypatch.delenv("DEUS_NATIVE_SESSION_ID", raising=False)
        with pytest.raises(SystemExit) as error:
            ta.main(["--backend", "deus-native", "--cwd", "/x"])
        assert error.value.code == 2

    def test_auto_session_only_missing_native_fails_cleanly(
        self, tmp_path, store, capsys
    ):
        rc = ta.main(
            [
                "--backend",
                "auto",
                "--session-id",
                "missing",
                "--native-transcripts-dir",
                str(tmp_path / "native"),
                "--json",
            ]
        )
        assert rc == 1
        result = json.loads(capsys.readouterr().out)
        assert result["ok"] is False
        assert "pass --cwd" in result["error"]
