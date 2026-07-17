from __future__ import annotations

import hashlib
import json
from pathlib import Path

from scripts import transcript_sources as ts

FIXTURE = Path(__file__).parent / "fixtures" / "deus_native_transcript_v1.jsonl"
SESSION_HASH = "0f85dde759830a939f71595b9461cc8731f7323758d5827e7ea550ab34baf02b"


def test_default_and_explicit_roots_match_typescript_layout(tmp_path):
    assert ts.native_transcript_root() == ts.REPOSITORY_ROOT / "store/transcripts/deus-native"
    assert ts.native_transcript_path("native-session-001").name == f"{SESSION_HASH}.jsonl"
    assert ts.native_transcript_path("native-session-001", tmp_path) == (
        tmp_path / "transcripts" / "deus-native" / f"{SESSION_HASH}.jsonl"
    )
    final = tmp_path / "native-final"
    assert ts.native_transcript_path(
        "native-session-001", native_transcripts_dir=final
    ) == final / f"{SESSION_HASH}.jsonl"
    assert hashlib.sha256("native-session-001".encode("utf-8")).hexdigest() == SESSION_HASH


def test_fixture_records_preserve_roles_content_metadata_and_unknown_fields():
    records = list(ts.iter_transcript_records(FIXTURE))
    assert [record.role for record in records] == ["user", "assistant", "user", "assistant"]
    assert {record.session_id for record in records} == {"native-session-001"}
    assert [record.turn_id for record in records] == [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]
    assert records[0].timestamp == "2026-07-17T12:00:00.000Z"
    assert records[0].group_folder == "whatsapp_main"
    assert records[1].message["model"] == "claude-sonnet-4-5"
    assert records[1].message["content"][1] == {
        "type": "tool_use",
        "id": "tool-call-1",
        "name": "web_search",
        "input": {"query": "relevant source"},
    }
    assert records[1].raw["cwd"] == "/absolute/project/path"


def test_completed_pairs_are_exact_and_do_not_cross_turn_ids(tmp_path):
    records = list(ts.iter_transcript_records(FIXTURE))
    pairs = list(ts.extract_completed_pairs(records))
    assert len(pairs) == 2
    assert pairs[0].prompt.startswith("Find the relevant source material")
    assert pairs[0].response.startswith("Here is the relevant source material")
    assert pairs[1].prompt.startswith("Summarize the conclusion")
    assert pairs[1].response.startswith("The conclusion is a complete")

    mismatched = tmp_path / "mismatched.jsonl"
    raw = [json.loads(line) for line in FIXTURE.read_text().splitlines()[:2]]
    raw[1]["turnId"] = "different-turn"
    mismatched.write_text("\n".join(json.dumps(item) for item in raw) + "\n")
    assert list(ts.extract_completed_pairs(ts.iter_transcript_records(mismatched))) == []


def test_malformed_line_warns_without_leaking_content_or_stopping(tmp_path):
    destination = tmp_path / "mixed.jsonl"
    lines = FIXTURE.read_text().splitlines()
    destination.write_text("\n".join([lines[0], "{private malformed", *lines[1:]]) + "\n")
    warnings: list[str] = []
    records = list(ts.iter_transcript_records(destination, warn=warnings.append))
    assert len(records) == 4
    assert records[-1].role == "assistant"
    assert warnings == [
        f"{destination}:2: skipped transcript record (JSONDecodeError)"
    ]
    assert "private malformed" not in warnings[0]


def test_store_scan_skips_bad_lines_and_continues_into_later_files(tmp_path):
    root = tmp_path / "native"
    root.mkdir()
    (root / "a.jsonl").write_text("not json\n")
    (root / "b.jsonl").write_bytes(FIXTURE.read_bytes())
    warnings: list[str] = []
    records = list(ts.iter_native_records(native_transcripts_dir=root, warn=warnings.append))
    assert len(records) == 4
    assert records[0].path.name == "b.jsonl"
    assert len(warnings) == 1


def test_blank_non_object_version_and_orphans_are_skipped(tmp_path):
    base = json.loads(FIXTURE.read_text().splitlines()[0])
    assistant = json.loads(FIXTURE.read_text().splitlines()[1])
    unsupported = {**base, "schemaVersion": 2}
    orphan_user = {**base, "turnId": "orphan-user"}
    orphan_assistant = {**assistant, "turnId": "orphan-assistant"}
    path = tmp_path / "invalids.jsonl"
    path.write_text(
        "\n"
        + "[]\n"
        + json.dumps(unsupported)
        + "\n"
        + json.dumps(orphan_user)
        + "\n"
        + json.dumps(orphan_assistant)
        + "\n"
    )
    warnings: list[str] = []
    records = list(ts.iter_transcript_records(path, warn=warnings.append))
    assert [record.turn_id for record in records] == ["orphan-user", "orphan-assistant"]
    assert list(ts.extract_completed_pairs(records)) == []
    assert any("non-object JSON" in warning for warning in warnings)
    assert any("unsupported schema version" in warning for warning in warnings)


def test_usage_preserves_missing_fields_and_has_no_cache_or_provenance(tmp_path):
    records = list(ts.iter_transcript_records(FIXTURE))
    first = ts.extract_native_usage(records[1])
    assert first == [
        ts.NativeUsageEvent("anthropic", "claude-haiku-4-5", 40, 10, 50),
        ts.NativeUsageEvent("anthropic", "claude-sonnet-4-5", 120, 30, 150),
    ]
    assert ts.extract_native_usage(records[3]) == [
        ts.NativeUsageEvent("anthropic", "claude-sonnet-4-5", 80, 20, 100)
    ]

    raw = json.loads(FIXTURE.read_text().splitlines()[1])
    raw["deusNative"]["usage"] = [
        {"provider": "anthropic", "model": "claude-sonnet-4-5", "outputTokens": 9}
    ]
    incomplete = tmp_path / "incomplete.jsonl"
    incomplete.write_text(json.dumps(raw) + "\n")
    event = ts.extract_native_usage(next(ts.iter_transcript_records(incomplete)))[0]
    assert event.input_tokens is None
    assert event.output_tokens == 9
    assert event.total_tokens is None
    assert not hasattr(event, "cache_read_input_tokens")
    assert not hasattr(event, "provenance")
