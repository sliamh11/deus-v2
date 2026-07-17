"""
Tests for evolution/backfill.py — exchange-pair chunking, chunk_stats, context_window.
"""
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

_NATIVE_FIXTURE = (
    Path(_PROJECT_ROOT) / "scripts/tests/fixtures/deus_native_transcript_v1.jsonl"
)


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")


def _make_entry(role: str, text: str) -> dict:
    return {"type": role, "message": {"content": text}}


# ── _extract_pairs ────────────────────────────────────────────────────────


def test_extract_pairs_yields_exchange_pairs(tmp_path):
    """Each yielded pair contains exactly one user turn and its following assistant turn."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "What is the capital of France?"),
        _make_entry("assistant", "The capital of France is Paris."),
        _make_entry("user", "What is the capital of Germany?"),
        _make_entry("assistant", "The capital of Germany is Berlin."),
    ])

    pairs = list(_extract_pairs(fpath))
    assert len(pairs) == 2
    assert pairs[0]["prompt"] == "What is the capital of France?"
    assert "Paris" in pairs[0]["response"]
    assert pairs[1]["prompt"] == "What is the capital of Germany?"
    assert "Berlin" in pairs[1]["response"]


def test_extract_pairs_pair_index_is_sequential(tmp_path):
    """pair_index increments from 0 for each yielded pair."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "First question here please"),
        _make_entry("assistant", "First answer to the question."),
        _make_entry("user", "Second question here please"),
        _make_entry("assistant", "Second answer to the question."),
    ])

    pairs = list(_extract_pairs(fpath))
    assert [p["pair_index"] for p in pairs] == [0, 1]


def test_extract_pairs_skips_short_prompts(tmp_path):
    """Prompts shorter than _MIN_PROMPT_LEN are skipped."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "hi"),                          # too short
        _make_entry("assistant", "Hello! How can I help?"),
        _make_entry("user", "What is the weather today?"),  # valid
        _make_entry("assistant", "I don't have real-time weather data."),
    ])

    pairs = list(_extract_pairs(fpath))
    assert len(pairs) == 1
    assert "weather" in pairs[0]["prompt"]


def test_extract_pairs_skips_error_responses(tmp_path):
    """Responses starting with error prefixes are skipped."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "Please do something for me today"),
        _make_entry("assistant", "API Error: rate limit exceeded"),  # skip
        _make_entry("user", "What is two plus two exactly?"),
        _make_entry("assistant", "Two plus two equals four."),
    ])

    pairs = list(_extract_pairs(fpath))
    assert len(pairs) == 1
    assert "two plus two" in pairs[0]["prompt"].lower()


def test_extract_pairs_with_context_window(tmp_path):
    """context_window > 0 includes preceding messages as 'context' field."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "Tell me about Python programming language"),
        _make_entry("assistant", "Python is a high-level programming language."),
        _make_entry("user", "What about its type system?"),
        _make_entry("assistant", "Python uses dynamic typing by default."),
    ])

    pairs = list(_extract_pairs(fpath, context_window=2))
    assert len(pairs) == 2

    # First pair has no prior context
    assert pairs[0].get("context") == [] or "context" not in pairs[0] or pairs[0]["context"] == []

    # Second pair should include the first exchange as context
    assert "context" in pairs[1]
    ctx_texts = [c["text"] for c in pairs[1]["context"]]
    assert any("Python" in t for t in ctx_texts)


def test_extract_pairs_no_context_window_by_default(tmp_path):
    """Without context_window, no 'context' key in yielded pairs."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "Tell me about Python programming language"),
        _make_entry("assistant", "Python is a high-level programming language."),
    ])

    pairs = list(_extract_pairs(fpath))
    assert len(pairs) == 1
    assert "context" not in pairs[0]


def test_extract_pairs_handles_corrupt_jsonl(tmp_path):
    """Corrupt .jsonl files return zero pairs (no exception)."""
    from evolution.backfill import _extract_pairs

    fpath = tmp_path / "session.jsonl"
    fpath.write_text("not valid json\n{broken")

    pairs = list(_extract_pairs(fpath))
    assert pairs == []


# ── collect_pairs + chunk_stats ───────────────────────────────────────────


def _make_session_dir(base: Path, project: str = "proj") -> Path:
    """Create the expected .claude/projects/<proj>/ directory structure."""
    d = base / "sessions" / "group" / ".claude" / "projects" / project
    d.mkdir(parents=True)
    return d


def test_chunk_stats_prints_summary(tmp_path, capsys):
    """--chunk-stats prints file count, pair count, and avg lengths."""
    from evolution.backfill import collect_pairs

    session_dir = _make_session_dir(tmp_path)
    fpath = session_dir / "abc123.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "What is the capital of France?"),
        _make_entry("assistant", "The capital of France is Paris."),
    ])

    collect_pairs(tmp_path / "sessions", chunk_stats=True)
    output = capsys.readouterr().out

    assert "Exchange-pair chunk stats" in output
    assert "files scanned" in output
    assert "total pairs extracted" in output
    assert "avg prompt length" in output


def test_chunk_stats_shows_zero_for_empty_dir(tmp_path, capsys):
    """--chunk-stats with no sessions prints zero counts."""
    from evolution.backfill import collect_pairs

    (tmp_path / "sessions").mkdir()
    collect_pairs(tmp_path / "sessions", chunk_stats=True)
    output = capsys.readouterr().out

    assert "0" in output


def test_collect_pairs_threads_context_window(tmp_path):
    """context_window parameter is forwarded from collect_pairs to _extract_pairs."""
    from evolution.backfill import collect_pairs

    session_dir = _make_session_dir(tmp_path)
    fpath = session_dir / "ctx_test.jsonl"
    _write_jsonl(fpath, [
        _make_entry("user", "Tell me about Python programming language"),
        _make_entry("assistant", "Python is a high-level programming language."),
        _make_entry("user", "What about its type system in detail?"),
        _make_entry("assistant", "Python uses dynamic typing by default."),
    ])

    # Without context_window: no context field
    pairs_no_ctx = collect_pairs(tmp_path / "sessions", context_window=0)
    assert all("context" not in p for p in pairs_no_ctx)

    # With context_window=2: second pair should have context from prior exchange
    pairs_with_ctx = collect_pairs(tmp_path / "sessions", context_window=2)
    assert len(pairs_with_ctx) == 2
    # First pair may have empty context (nothing before it)
    # Second pair should have context
    second = pairs_with_ctx[1]
    assert "context" in second
    ctx_texts = [c["text"] for c in second["context"]]
    assert any("Python" in t for t in ctx_texts)


def _native_dir(tmp_path: Path) -> Path:
    root = tmp_path / "native"
    root.mkdir()
    shutil.copyfile(_NATIVE_FIXTURE, root / "native.jsonl")
    return root


def test_native_fixture_yields_expected_pairs_groups_and_stable_namespaced_ids(
    tmp_path,
):
    from evolution.backfill import (
        _deterministic_native_id,
        collect_pairs,
    )

    sessions = tmp_path / "sessions"
    sessions.mkdir()
    native = _native_dir(tmp_path)
    first = collect_pairs(sessions, native_transcripts_dir=native)
    second = collect_pairs(sessions, native_transcripts_dir=native)

    assert len(first) == 2
    assert first == second
    assert [pair["group_folder"] for pair in first] == [
        "whatsapp_main",
        "whatsapp_main",
    ]
    assert first[0]["prompt"].startswith("Find the relevant source material")
    assert first[1]["response"].startswith("The conclusion is a complete")
    assert first[0]["interaction_id"] == _deterministic_native_id(
        "native-session-001", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0
    )
    assert first[0]["source"] == "deus-native"


def _build_ordering_case(base: Path, creation_order: list[str]) -> tuple[Path, Path]:
    sessions = base / "sessions"
    directory = sessions / "group" / ".claude" / "projects" / "proj"
    directory.mkdir(parents=True)
    entries = {
        "a-session": [
            _make_entry("user", "Legacy alpha prompt that is long enough"),
            _make_entry("assistant", "Legacy alpha response that is long enough."),
        ],
        "z-session": [
            _make_entry("user", "Legacy omega prompt that is long enough"),
            _make_entry("assistant", "Legacy omega response that is long enough."),
        ],
    }
    for name in creation_order:
        _write_jsonl(directory / f"{name}.jsonl", entries[name])
    # Deliberately reverse mtimes relative to lexical path order.
    os.utime(directory / "a-session.jsonl", (2_000_000_000, 2_000_000_000))
    os.utime(directory / "z-session.jsonl", (1_000_000_000, 1_000_000_000))
    native = _native_dir(base)
    return sessions, native


def test_combined_legacy_then_native_limit_is_path_deterministic_across_creation_order_and_mtime(
    tmp_path,
):
    from evolution.backfill import _deterministic_id, collect_pairs

    first_sessions, first_native = _build_ordering_case(
        tmp_path / "first", ["z-session", "a-session"]
    )
    second_sessions, second_native = _build_ordering_case(
        tmp_path / "second", ["a-session", "z-session"]
    )

    def projection(sessions, native):
        return [
            (pair["interaction_id"], pair["session_id"], pair["prompt"])
            for pair in collect_pairs(
                sessions, limit=3, native_transcripts_dir=native
            )
        ]

    first = projection(first_sessions, first_native)
    second = projection(second_sessions, second_native)
    assert first == second
    assert first[0][0] == _deterministic_id("a-session", 0)
    assert first[1][0] == _deterministic_id("z-session", 0)
    assert first[2][1] == "native-session-001"


def test_native_and_legacy_ingestion_keep_backfill_eval_suite(
    tmp_path, monkeypatch
):
    from evolution import backfill

    sessions, native = _build_ordering_case(tmp_path, ["a-session", "z-session"])
    logged = []
    monkeypatch.setattr(backfill, "_already_processed", lambda _iid: False)
    monkeypatch.setattr(
        backfill,
        "make_runtime_judge",
        lambda: SimpleNamespace(
            evaluate=lambda **_kwargs: SimpleNamespace(
                score=1.0,
                quality=1.0,
                safety=1.0,
                tool_use=1.0,
                personalization=1.0,
                rationale="ok",
                schema_version=1,
            )
        ),
    )
    monkeypatch.setattr(backfill, "log_interaction", lambda **kwargs: logged.append(kwargs))
    monkeypatch.setattr(backfill, "update_score", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(backfill.time, "sleep", lambda _seconds: None)

    stats = backfill.run_backfill(
        sessions_dir=sessions,
        native_transcripts_dir=native,
        verbose=False,
    )
    assert stats["processed"] == 4
    assert {entry["eval_suite"] for entry in logged} == {"backfill"}
    assert {entry["group_folder"] for entry in logged} == {
        "group",
        "whatsapp_main",
    }


def test_native_transcript_argument_threads_through_both_backfill_clis(
    tmp_path, monkeypatch
):
    from evolution import backfill, cli

    sessions = tmp_path / "sessions"
    native = tmp_path / "native"
    captured = []

    def fake_run_backfill(**kwargs):
        captured.append(kwargs)
        return {
            "total": 0,
            "skipped_existing": 0,
            "processed": 0,
            "failed": 0,
            "reflections_generated": 0,
        }

    monkeypatch.setattr(backfill, "run_backfill", fake_run_backfill)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "backfill",
            "--sessions-dir",
            str(sessions),
            "--native-transcripts-dir",
            str(native),
            "--quiet",
        ],
    )
    backfill.main()
    assert captured[-1]["native_transcripts_dir"] == native

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "evolution",
            "backfill",
            "--sessions-dir",
            str(sessions),
            "--native-transcripts-dir",
            str(native),
            "--quiet",
        ],
    )
    cli.main()
    assert captured[-1]["native_transcripts_dir"] == native
