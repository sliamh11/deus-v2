from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from scripts import analyze_token_efficiency as ate

FIXTURE = Path(__file__).parent / "fixtures" / "deus_native_transcript_v1.jsonl"


@pytest.fixture(autouse=True)
def isolate_evolution_db(tmp_path, monkeypatch):
    monkeypatch.setattr(ate, "EVOLUTION_DB", tmp_path / "missing-evolution.db")


def native_dir(tmp_path: Path) -> Path:
    root = tmp_path / "native"
    root.mkdir()
    shutil.copyfile(FIXTURE, root / "native.jsonl")
    return root


def cc_dir(tmp_path: Path) -> Path:
    root = tmp_path / "cc-project"
    root.mkdir()
    usage = [
        ("cc-1", "claude-haiku-4-5", 40, 10, 50),
        ("cc-2", "claude-sonnet-4-5", 120, 30, 150),
        ("cc-3", "claude-sonnet-4-5", 80, 20, 100),
    ]
    records = []
    for index, (message_id, model, input_tokens, output_tokens, total_tokens) in enumerate(
        usage
    ):
        records.append(
            {
                "type": "assistant",
                "sessionId": "cc-session",
                "uuid": f"uuid-{index}",
                "requestId": f"request-{index}",
                "timestamp": f"2026-07-17T12:0{index}:02.000Z",
                "message": {
                    "id": message_id,
                    "model": model,
                    "usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_tokens": total_tokens,
                        "cache_read_input_tokens": 11,
                        "cache_creation_input_tokens": 5,
                    },
                },
            }
        )
    (root / "cc.jsonl").write_text(
        "\n".join(json.dumps(record) for record in records) + "\n"
    )
    return root


def test_native_and_cc_overlap_on_known_model_token_values(tmp_path, monkeypatch):
    native = ate.load_native_usage(None, None, native_dir(tmp_path))
    monkeypatch.setattr(ate, "CLI_TRANSCRIPTS_DIR", cc_dir(tmp_path))
    cli = ate.load_cli_usage(None, None)

    native_calls = [
        (
            call.model,
            call.input_tokens,
            call.output_tokens,
            call.total_tokens,
        )
        for turn in native
        for call in turn.calls
    ]
    cli_calls = [
        (entry.model, entry.input_tokens, entry.output_tokens, entry.input_tokens + entry.output_tokens)
        for entry in cli
    ]
    assert native_calls == cli_calls


def test_native_multi_event_turn_counts_once_and_sums_each_complete_call(tmp_path):
    turns = ate.load_native_usage(None, None, native_dir(tmp_path))
    summary = ate.summarize_native_usage(turns)
    assert summary["turns"] == 2
    assert summary["calls"] == 3
    assert len(turns[0].calls) == 2
    assert sum(call.input_tokens for call in turns[0].calls) == 160
    assert sum(call.output_tokens for call in turns[0].calls) == 40
    assert sum(call.total_tokens for call in turns[0].calls) == 200
    assert summary["input_tokens"] == 240
    assert summary["output_tokens"] == 60
    assert summary["total_tokens"] == 300


def test_unreported_usage_is_counted_but_excluded_from_token_math(tmp_path):
    root = native_dir(tmp_path)
    records = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    records[1]["deusNative"]["usage"].append(
        {
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "outputTokens": 999,
        }
    )
    (root / "native.jsonl").write_text(
        "\n".join(json.dumps(record) for record in records) + "\n"
    )
    summary = ate.summarize_native_usage(ate.load_native_usage(None, None, root))
    assert summary["calls"] == 4
    assert summary["reported_calls"] == 3
    assert summary["unreported_calls"] == 1
    assert summary["input_tokens"] == 240
    assert summary["output_tokens"] == 60
    assert summary["total_tokens"] == 300


def test_native_rendering_uses_variant_b_and_never_renders_cache_as_zero(tmp_path):
    summary = ate.summarize_native_usage(
        ate.load_native_usage(None, None, native_dir(tmp_path))
    )
    rendered = "\n".join(ate.format_native_usage(summary))
    assert "-- Deus-native usage --" in rendered
    assert "turns:          2  model calls: 3" in rendered
    assert "cache:          not reported by deus-native" in rendered
    assert "cache 0" not in rendered
    assert "0%" not in rendered
    assert "anthropic/claude-haiku-4-5" in rendered
    assert "anthropic/claude-sonnet-4-5" in rendered


def test_claude_dedup_and_cache_accounting_remain_unchanged(tmp_path, monkeypatch):
    project = cc_dir(tmp_path)
    first = (project / "cc.jsonl").read_text().splitlines()[0]
    with (project / "cc.jsonl").open("a") as handle:
        handle.write(first + "\n")
    monkeypatch.setattr(ate, "CLI_TRANSCRIPTS_DIR", project)
    entries = ate.load_cli_usage(None, None)
    assert len(entries) == 3
    assert sum(entry.cache_read for entry in entries) == 33
    assert sum(entry.cache_create for entry in entries) == 15


def test_text_and_json_keep_claude_and_native_sections_separate(
    tmp_path, monkeypatch, capsys
):
    native = native_dir(tmp_path)
    cli = cc_dir(tmp_path)
    monkeypatch.setattr(ate, "GROUPS_DIR", tmp_path / "no-groups")
    monkeypatch.setattr(ate, "CLI_TRANSCRIPTS_DIR", None)

    assert (
        ate.main(
            [
                "--cli-project-dir",
                str(cli),
                "--native-transcripts-dir",
                str(native),
                "--pricing",
                "none",
            ]
        )
        == 0
    )
    text = capsys.readouterr().out
    assert "CLI (this session path)" in text
    assert "-- Deus-native usage --" in text
    assert "CLI total" in text
    assert "deus-native" in text

    assert (
        ate.main(
            [
                "--cli-project-dir",
                str(cli),
                "--native-transcripts-dir",
                str(native),
                "--json",
            ]
        )
        == 0
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["deus_native_usage"]["source"] == "deus-native"
    assert payload["deus_native_usage"]["turns"] == 2
    assert payload["cli_usage"]["n_sessions"] == 1
    assert "deus_native_usage" not in payload["cli_usage"]


def test_native_only_install_passes_no_data_gate_and_emits_native_output(
    tmp_path, monkeypatch, capsys
):
    native = native_dir(tmp_path)
    monkeypatch.setattr(ate, "GROUPS_DIR", tmp_path / "no-groups")
    monkeypatch.setattr(ate, "CLI_PROJECTS_ROOT", tmp_path / "no-projects")
    monkeypatch.setattr(ate, "CLI_TRANSCRIPTS_DIR", None)

    rc = ate.main(
        ["--native-transcripts-dir", str(native), "--pricing", "none"]
    )
    assert rc == 0
    output = capsys.readouterr().out
    assert "-- Deus-native usage --" in output
    assert "turns:          2" in output


def test_no_data_gate_names_all_three_sources(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(ate, "GROUPS_DIR", tmp_path / "no-groups")
    monkeypatch.setattr(ate, "CLI_PROJECTS_ROOT", tmp_path / "no-projects")
    monkeypatch.setattr(ate, "CLI_TRANSCRIPTS_DIR", None)
    rc = ate.main(["--native-transcripts-dir", str(tmp_path / "no-native")])
    assert rc == 1
    error = capsys.readouterr().err
    assert "groups" in error
    assert "Claude CLI transcripts" in error
    assert "Deus-native transcripts" in error
