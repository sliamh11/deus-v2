#!/usr/bin/env python3
"""Fail-soft readers for Deus-owned native transcript JSONL files."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
Warn = Callable[[str], None]


@dataclass(frozen=True)
class TranscriptRecord:
    source: str
    path: Path
    line_no: int
    session_id: str
    role: str
    message: Mapping[str, Any]
    timestamp: str | None
    native_metadata: Mapping[str, Any]
    raw: Mapping[str, Any]

    @property
    def turn_id(self) -> str | None:
        value = self.raw.get("turnId")
        return value if isinstance(value, str) and value else None

    @property
    def group_folder(self) -> str | None:
        value = self.raw.get("groupFolder")
        return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class ConversationPair:
    session_id: str
    turn_id: str
    group_folder: str
    prompt: str
    response: str
    user: TranscriptRecord
    assistant: TranscriptRecord


@dataclass(frozen=True)
class NativeUsageEvent:
    provider: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None


def native_transcript_root(
    store_dir: str | Path | None = None,
    *,
    native_transcripts_dir: str | Path | None = None,
) -> Path:
    """Resolve the final native transcript directory.

    ``store_dir`` is the STORE_DIR-equivalent base. ``native_transcripts_dir``
    is an explicit final-directory override for atypical process roots.
    """
    if store_dir is not None and native_transcripts_dir is not None:
        raise ValueError("pass store_dir or native_transcripts_dir, not both")
    if native_transcripts_dir is not None:
        return Path(native_transcripts_dir).expanduser()
    base = Path(store_dir).expanduser() if store_dir is not None else REPOSITORY_ROOT / "store"
    return base / "transcripts" / "deus-native"


def native_transcript_path(
    session_id: str,
    store_dir: str | Path | None = None,
    *,
    native_transcripts_dir: str | Path | None = None,
) -> Path:
    if not session_id:
        raise ValueError("deus-native transcript session id must not be empty")
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return native_transcript_root(
        store_dir, native_transcripts_dir=native_transcripts_dir
    ) / f"{digest}.jsonl"


def iter_native_transcript_files(
    store_dir: str | Path | None = None,
    *,
    native_transcripts_dir: str | Path | None = None,
) -> Iterator[Path]:
    root = native_transcript_root(
        store_dir, native_transcripts_dir=native_transcripts_dir
    )
    if not root.is_dir():
        return
    yield from sorted(root.glob("*.jsonl"), key=lambda item: item.as_posix())


def _warning(warn: Warn | None, path: Path, line_no: int, reason: str) -> None:
    if warn is not None:
        warn(f"{path}:{line_no}: skipped transcript record ({reason})")


def iter_transcript_records(
    path: str | Path, *, warn: Warn | None = None
) -> Iterator[TranscriptRecord]:
    """Read supported native records one line at a time, skipping bad lines."""
    transcript_path = Path(path)
    try:
        handle = transcript_path.open("r", encoding="utf-8")
    except OSError as error:
        _warning(warn, transcript_path, 0, type(error).__name__)
        return

    with handle:
        for line_no, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except (json.JSONDecodeError, UnicodeError) as error:
                _warning(warn, transcript_path, line_no, type(error).__name__)
                continue
            if not isinstance(raw, dict):
                _warning(warn, transcript_path, line_no, "non-object JSON")
                continue
            if raw.get("schemaVersion") != 1:
                _warning(warn, transcript_path, line_no, "unsupported schema version")
                continue
            if raw.get("source") != "deus-native":
                _warning(warn, transcript_path, line_no, "unsupported source")
                continue

            message = raw.get("message")
            native_metadata = raw.get("deusNative")
            session_id = raw.get("sessionId")
            role = raw.get("role")
            timestamp = raw.get("timestamp")
            if not isinstance(message, dict):
                _warning(warn, transcript_path, line_no, "missing message object")
                continue
            if not isinstance(native_metadata, dict):
                _warning(warn, transcript_path, line_no, "missing native metadata")
                continue
            if not isinstance(session_id, str) or not session_id:
                _warning(warn, transcript_path, line_no, "missing session id")
                continue
            if role not in {"user", "assistant"}:
                _warning(warn, transcript_path, line_no, "unsupported role")
                continue
            yield TranscriptRecord(
                source="deus-native",
                path=transcript_path,
                line_no=line_no,
                session_id=session_id,
                role=role,
                message=message,
                timestamp=timestamp if isinstance(timestamp, str) else None,
                native_metadata=native_metadata,
                raw=raw,
            )


def iter_native_records(
    store_dir: str | Path | None = None,
    *,
    native_transcripts_dir: str | Path | None = None,
    warn: Warn | None = None,
) -> Iterator[TranscriptRecord]:
    for transcript_path in iter_native_transcript_files(
        store_dir, native_transcripts_dir=native_transcripts_dir
    ):
        yield from iter_transcript_records(transcript_path, warn=warn)


def _user_text(record: TranscriptRecord) -> str | None:
    content = record.message.get("content")
    return content if isinstance(content, str) else None


def _assistant_text(record: TranscriptRecord) -> str | None:
    content = record.message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    text = [
        block.get("text")
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "\n".join(text)


def extract_completed_pairs(
    records: Iterable[TranscriptRecord],
) -> Iterator[ConversationPair]:
    """Yield adjacent user/assistant records sharing session and turn ids."""
    pending: TranscriptRecord | None = None
    for record in records:
        if record.role == "user":
            pending = record if record.turn_id is not None else None
            continue
        if record.role != "assistant" or pending is None:
            continue
        if (
            record.turn_id != pending.turn_id
            or record.session_id != pending.session_id
            or record.turn_id is None
        ):
            pending = None
            continue
        prompt = _user_text(pending)
        response = _assistant_text(record)
        group_folder = pending.group_folder
        if prompt is not None and response is not None and group_folder is not None:
            yield ConversationPair(
                session_id=record.session_id,
                turn_id=record.turn_id,
                group_folder=group_folder,
                prompt=prompt,
                response=response,
                user=pending,
                assistant=record,
            )
        pending = None


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def extract_native_usage(record: TranscriptRecord) -> list[NativeUsageEvent]:
    raw_usage = record.native_metadata.get("usage")
    if not isinstance(raw_usage, list):
        return []
    events: list[NativeUsageEvent] = []
    for raw in raw_usage:
        if not isinstance(raw, dict):
            continue
        provider = raw.get("provider")
        model = raw.get("model")
        if not isinstance(provider, str) or not isinstance(model, str):
            continue
        events.append(
            NativeUsageEvent(
                provider=provider,
                model=model,
                input_tokens=_optional_int(raw.get("inputTokens")),
                output_tokens=_optional_int(raw.get("outputTokens")),
                total_tokens=_optional_int(raw.get("totalTokens")),
            )
        )
    return events
