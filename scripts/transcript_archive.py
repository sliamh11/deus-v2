#!/usr/bin/env python3
"""transcript_archive.py — content-addressed cold-source retention (LIA-374).

`/compress` writes ~170x lossy session summaries while the byte-exact source
(the Claude Code transcript JSONL) is orphaned under Claude Code's own
retention. This archives the transcript into a content-addressed cold store
(default `~/.deus/archive/transcripts/<sha256>.jsonl.zst`) so a summary's
`source_transcript:` frontmatter key can always decompress back to source.

Design: content-addressable store (the standard dedup/immutability pattern —
same family as git objects): sha256-of-raw-bytes key, single flat directory,
O(1) lookup, idempotent writes, append-only (no-db-deletion philosophy).
Transcript resolution preserves Claude's registry/newest fallback and adds an
exact SHA-256-named Deus-native session lookup. Explicit transcript paths still
bypass backend resolution and are archived byte-for-byte.

The store default lives under `~/.deus/` — deliberately OUTSIDE the
Obsidian/OneDrive-synced vault (raw transcripts carry PII; only the sha
reference enters the vault). Compression: zstd -19 via the CLI when present,
gzip fallback otherwise (cross-platform default; flagged in the JSON output).
`--best-effort` never raises and always exits 0 — archival must never block
`/compress`.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from transcript_sources import native_transcript_path
except ModuleNotFoundError:  # Imported as scripts.transcript_archive in tests.
    from scripts.transcript_sources import native_transcript_path


def archive_dir() -> Path:
    """Public: the content-addressed store location (recall_source depends on it)."""
    return Path(
        os.environ.get(
            "DEUS_TRANSCRIPT_ARCHIVE_DIR",  # LIA-374
            "~/.deus/archive/transcripts",
        )
    ).expanduser()


# Backward-compat private alias (early callers/tests used the underscore name).
_archive_dir = archive_dir


def _sessions_dir() -> Path:
    return Path("~/.claude/sessions").expanduser()


def _projects_dir() -> Path:
    return Path("~/.claude/projects").expanduser()


def _zstd_bin() -> str | None:
    return shutil.which("zstd")


class TranscriptResolutionError(ValueError):
    """A clean, user-facing transcript source resolution failure."""


def _claude_slug_dir(cwd: str) -> Path:
    slug = re.sub(r"[^A-Za-z0-9-]", "-", cwd)
    return _projects_dir() / slug


def resolve_claude_transcript(
    cwd: str,
    *,
    session_id: str | None = None,
    include_environment: bool = True,
) -> Path | None:
    """Locate the current session's transcript for `cwd`.

    Ordered fallback chain: (0) `CLAUDE_SESSION_ID` env → that exact
    transcript (the repo's established disambiguator for concurrent
    same-cwd sessions — see session_preflight's self-exclusion); (1) newest
    session-registry entry whose cwd matches → `<projects>/<slug>/
    <sessionId>.jsonl`; (2) newest `*.jsonl` in the slug dir. None when
    nothing matches. Without (0), two live sessions on one cwd could get a
    SIBLING session's transcript backlinked — ok:true, wrong source.

    Slug encoding: Claude Code maps every non-alphanumeric character (both
    `/` and `.`) to `-` — e.g. `/x/.claude/wt` → `-x--claude-wt`. A plain
    `/`→`-` replace misses dotted segments and silently resolves nothing.
    """
    slug_dir = _claude_slug_dir(cwd)

    if session_id:
        exact = slug_dir / f"{session_id}.jsonl"
        return exact if exact.is_file() else None

    own_session = (
        os.environ.get("CLAUDE_SESSION_ID", "").strip()
        if include_environment
        else ""
    )
    if own_session:
        own = slug_dir / f"{own_session}.jsonl"
        if own.is_file():
            return own

    candidates: list[tuple[float, Path]] = []
    sessions = _sessions_dir()
    if sessions.is_dir():
        for f in sessions.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if data.get("cwd") != cwd or not data.get("sessionId"):
                continue
            transcript = slug_dir / f"{data['sessionId']}.jsonl"
            if transcript.is_file():
                candidates.append((f.stat().st_mtime, transcript))
    if candidates:
        return max(candidates)[1]

    if slug_dir.is_dir():
        jsonls = sorted(
            slug_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
        )
        if jsonls:
            return jsonls[0]
    return None


# Backward-compatible name retained for existing callers/tests. The explicit
# name above records that this resolver is Claude Code-specific.
def resolve_transcript(cwd: str) -> Path | None:
    return resolve_claude_transcript(cwd)


def resolve_native_transcript(
    session_id: str,
    *,
    native_transcripts_dir: str | Path | None = None,
) -> Path | None:
    candidate = native_transcript_path(
        session_id, native_transcripts_dir=native_transcripts_dir
    )
    return candidate if candidate.is_file() else None


def resolve_auto_transcript(
    *,
    cwd: str | None,
    session_id: str | None,
    native_transcripts_dir: str | Path | None = None,
) -> Path | None:
    """Resolve auto mode with the frozen F5 precedence and ambiguity rule."""
    if session_id:
        native = resolve_native_transcript(
            session_id, native_transcripts_dir=native_transcripts_dir
        )
        claude = (
            resolve_claude_transcript(cwd, session_id=session_id) if cwd else None
        )
        if native is not None and claude is not None:
            raise TranscriptResolutionError(
                f'session "{session_id}" exists in both deus-native and Claude stores; '
                "pass --backend deus-native or --backend claude"
            )
        if native is not None:
            return native
        if claude is not None:
            return claude
        if cwd is None:
            raise TranscriptResolutionError(
                f'no native transcript found for session "{session_id}"; '
                "pass --cwd to allow an exact Claude lookup"
            )
        return None

    if cwd is None:
        return None

    # DEUS_NATIVE_SESSION_ID (LIA-427): set by the deus-native runtime to identify
    # which owned transcript to resolve for this cwd.
    native_environment_id = os.environ.get("DEUS_NATIVE_SESSION_ID", "").strip()
    if native_environment_id:
        native = resolve_native_transcript(
            native_environment_id,
            native_transcripts_dir=native_transcripts_dir,
        )
        if native is not None:
            return native

    claude_environment_id = os.environ.get("CLAUDE_SESSION_ID", "").strip()
    if claude_environment_id:
        claude = resolve_claude_transcript(
            cwd, session_id=claude_environment_id
        )
        if claude is not None:
            return claude

    # Suppress the environment lookup inside the Claude resolver: the exact
    # CLAUDE_SESSION_ID candidate was already evaluated at precedence step 3.
    return resolve_claude_transcript(cwd, include_environment=False)


def archive(transcript: Path, *, best_effort: bool = False) -> dict:
    """Compress `transcript` into the content-addressed store.

    Returns {"ok", "sha256", "dest", "skipped", "codec"} on success;
    in best-effort mode failures return {"ok": False, "error": ...}
    instead of raising.
    """
    try:
        raw = Path(transcript).read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        store = archive_dir()
        store.mkdir(parents=True, exist_ok=True)

        for suffix in (".jsonl.zst", ".jsonl.gz"):
            existing = store / f"{sha}{suffix}"
            if existing.exists():
                return {
                    "ok": True,
                    "sha256": sha,
                    "dest": str(existing),
                    "skipped": True,
                    "codec": "zstd" if suffix.endswith("zst") else "gzip",
                }

        zstd = _zstd_bin()
        if zstd:
            dest = store / f"{sha}.jsonl.zst"
            tmp = store / f".{sha}.tmp.zst"
            subprocess.run(
                [zstd, "-19", "-q", "-f", "-o", str(tmp), str(transcript)],
                check=True,
                capture_output=True,
            )
            tmp.rename(dest)
            codec = "zstd"
        else:
            dest = store / f"{sha}.jsonl.gz"
            tmp = store / f".{sha}.tmp.gz"
            with gzip.open(tmp, "wb", compresslevel=9) as f:
                f.write(raw)
            tmp.rename(dest)
            codec = "gzip"

        return {
            "ok": True,
            "sha256": sha,
            "dest": str(dest),
            "skipped": False,
            "codec": codec,
        }
    except Exception as e:  # noqa: BLE001 — best-effort must swallow everything
        if best_effort:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
        raise


def decompress(dest: Path) -> bytes:
    """Restore the raw transcript bytes from an archived file."""
    dest = Path(dest)
    if dest.suffix == ".zst":
        zstd = _zstd_bin()
        if not zstd:
            raise RuntimeError("zstd binary required to decompress .zst archives")
        proc = subprocess.run(
            [zstd, "-d", "-q", "-c", str(dest)], check=True, capture_output=True
        )
        return proc.stdout
    return gzip.decompress(dest.read_bytes())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="transcript_archive",
        description="Archive a session transcript into the content-addressed cold store.",
    )
    src = parser.add_mutually_exclusive_group(required=False)
    src.add_argument("--cwd", help="Session cwd — resolve its transcript automatically")
    src.add_argument("--transcript", help="Explicit transcript path")
    parser.add_argument(
        "--backend",
        choices=("auto", "claude", "deus-native"),
        default="auto",
        help="Transcript backend for automatic source resolution (default: auto)",
    )
    parser.add_argument("--session-id", help="Exact runtime session id")
    parser.add_argument(
        "--native-transcripts-dir",
        help="Override the final Deus-native transcript directory",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    parser.add_argument(
        "--best-effort",
        action="store_true",
        help="Never fail: errors exit 0 with ok:false JSON (for /compress)",
    )
    args = parser.parse_args(argv)

    if args.transcript and args.session_id:
        parser.error("--transcript cannot be combined with --session-id")
    if args.backend == "claude":
        if not args.transcript and not args.cwd:
            parser.error("--backend claude requires --cwd or --transcript")
    elif args.backend == "deus-native":
        if args.cwd and args.session_id:
            parser.error(
                "--backend deus-native does not combine --cwd with explicit --session-id"
            )
        if not args.transcript and not args.session_id and not args.cwd:
            parser.error(
                "--backend deus-native requires --session-id, --cwd, or --transcript"
            )
        # DEUS_NATIVE_SESSION_ID (LIA-427): required to resolve the owned transcript by cwd.
        if args.cwd and not os.environ.get("DEUS_NATIVE_SESSION_ID", "").strip():
            parser.error(
                "--backend deus-native with --cwd requires DEUS_NATIVE_SESSION_ID"
            )
    elif not args.transcript and not args.cwd and not args.session_id:
        parser.error("--backend auto requires --cwd, --session-id, or --transcript")

    if args.transcript:
        transcript: Path | None = Path(args.transcript)
        if not transcript.is_file():
            # Same clean-error shape as the --cwd branch — a raw traceback is
            # not an acceptable CLI failure mode for user-supplied paths.
            transcript = None
            missing = f"transcript not found: {args.transcript}"
    elif args.backend == "claude":
        transcript = resolve_claude_transcript(
            args.cwd, session_id=args.session_id
        )
        missing = (
            f"no Claude transcript found for session {args.session_id} in cwd {args.cwd}"
            if args.session_id
            else f"no Claude transcript found for cwd {args.cwd}"
        )
    elif args.backend == "deus-native":
        native_session_id = args.session_id or os.environ.get(
            "DEUS_NATIVE_SESSION_ID", ""
        ).strip()
        transcript = resolve_native_transcript(
            native_session_id,
            native_transcripts_dir=args.native_transcripts_dir,
        )
        missing = f"no deus-native transcript found for session {native_session_id}"
    else:
        try:
            transcript = resolve_auto_transcript(
                cwd=args.cwd,
                session_id=args.session_id,
                native_transcripts_dir=args.native_transcripts_dir,
            )
            missing = (
                f"no transcript found for session {args.session_id} and cwd {args.cwd}"
                if args.session_id
                else f"no transcript found for cwd {args.cwd}"
            )
        except TranscriptResolutionError as error:
            transcript = None
            missing = str(error)

    if transcript is None:
        result: dict = {"ok": False, "error": missing}
    else:
        result = archive(transcript, best_effort=args.best_effort)

    if args.json:
        print(json.dumps(result))
    elif result["ok"]:
        print(f"{result['sha256']}  {result['dest']}")
    else:
        print(f"error: {result['error']}", file=sys.stderr)

    if not result["ok"] and not args.best_effort:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
