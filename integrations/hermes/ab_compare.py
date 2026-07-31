#!/usr/bin/env python3
"""A/B/n compare Hermes model profiles on a shared prompt, scored by Deus's
own judge harness (``evolution.judge``).

LIA-501. Not "wired through `gateway.profile_routes`/`multiplex_profiles`" as
the ticket originally named it - those are a live-gateway inbound-message
routing mechanism (Discord/Telegram/HTTP chat_id -> profile), unrelated to a
synchronous batch script issuing prompts and reading replies. The actual
per-model isolation primitive this script drives is Hermes **Profiles**
themselves (``hermes profile create <name>``, each with its own
``config.yaml`` -> ``model.default``/``model.model``), invoked
non-interactively via ``hermes -p <profile> chat -q "<prompt>" -Q``. This is
the same mechanism this integration's own README already points at for
per-*contact* isolation (see ../hermes/README.md's Security model section,
point 1), applied here to per-*model* isolation instead. No gateway process
needs to run for this rig.

PRECONDITION (not automated by this script): the profiles named on
--profiles must already exist, each with a different `model.default` (or
legacy `model.model`) set - one-time manual setup via:

    hermes profile create <name>
    hermes -p <name> config set model.default <model-id>

This script only *consumes* existing profiles; it never creates or
configures one.

MEMORY-POLLUTION WARNING: do not point this rig at a profile that has
`memory.provider: deus` configured (see ../hermes/deus_memory_provider).
`DeusMemoryProvider.sync_turn()` only skips logging when
`agent_context != "primary"`, and a plain `hermes -p <profile> chat -q` run
has no way to pass a non-"primary" `agent_context` - so a synthetic A/B
comparison run against such a profile would get logged into the evolution
store as if it were a real user interaction, polluting the exact data the
judge/evolution loop is calibrated against. This script does not (and
cannot, from outside Hermes's process) detect or block this; keep A/B
profiles free of `memory.provider: deus`.

Usage:
    python integrations/hermes/ab_compare.py \\
        --profiles model-a,model-b,model-c \\
        --prompt "What's the capital of France?"

    python integrations/hermes/ab_compare.py \\
        --profiles model-a,model-b \\
        --conversation turns.json \\
        --judge-provider ollama \\
        --json results.json

``turns.json`` is a JSON list[str] of user turns, replayed in order against
each profile (chained within a profile via `--resume`); the LAST turn's
response is what gets judged, earlier turns are joined and passed as the
judge's `context`.

Execution is sequential across profiles (deliberately - "near-zero code" for
this pass; bounded parallelism via ThreadPoolExecutor, mirroring this
integration's own `_SYNC_TURN_CONCURRENCY_LIMIT` pattern in
`deus_memory_provider/__init__.py`, is a documented follow-up, not built
here).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Make deus-v2-mvp's own `evolution` package importable regardless of the
# caller's cwd. `evolution` is NOT reliably on sys.path otherwise - a bare
# `import evolution.judge` silently resolves to whatever `evolution` package
# happens to be importable via cwd (confirmed this session: running from a
# sibling checkout's directory resolved to THAT checkout's `evolution`
# package instead, same class of ambient-resolution hazard the existing
# `deus_memory_provider/__init__.py` calls out for `python3`/PATH). Mirrors
# `eval/judge_model.py`'s own explicit sys.path insertion, adjusted for this
# file's deeper nesting (integrations/hermes/ vs eval/).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from evolution.judge import (  # noqa: E402
    JudgeResult,
    NoProviderAvailableError,
    make_runtime_judge,
)

try:
    import yaml
except ImportError:  # pragma: no cover - PyYAML is a transitive dep of
    # evolution/requirements.txt in every environment this script is meant
    # to run in; this is a defensive fallback so a missing PyYAML degrades
    # the report's "model" column to "unknown" rather than crashing the run.
    yaml = None  # type: ignore[assignment]

_DEFAULT_HERMES_HOME = Path.home() / ".hermes"
# Matches cli.py's single-query exit line: `print(f"\nsession_id: {id}", ...)`
# written to stderr regardless of -Q (confirmed at cli.py's quiet single-query
# branch, ~line 17913).
_SESSION_ID_RE = re.compile(r"session_id:\s*(\S+)")


@dataclass
class TurnResult:
    stdout: str
    stderr: str
    returncode: int
    session_id: Optional[str]
    timed_out: bool
    duration_s: float


@dataclass
class ProfileResult:
    profile: str
    model: Optional[str] = None
    latency_s: Optional[float] = None
    judge: Optional[JudgeResult] = None
    error: Optional[str] = None
    final_answer: Optional[str] = None


def resolve_profile_model(profile: str, hermes_home: Path = _DEFAULT_HERMES_HOME) -> Optional[str]:
    """Best-effort read of a profile's configured model, for the report only.

    Never raises: a missing/unreadable config just means the report shows
    "unknown" rather than aborting the whole run over a display detail.
    Mirrors hermes-agent's own `hermes_cli/profiles.py::_read_config_model`
    (confirmed: "Both 'default' and 'model' work as the key name" under
    `model:` in config.yaml) and its "default" profile special-case
    (`get_profile_dir`: the "default" profile's home IS `~/.hermes` itself,
    not a `profiles/default` subdirectory).
    """
    if yaml is None:
        return None

    if profile == "default":
        config_path = hermes_home / "config.yaml"
    else:
        config_path = hermes_home / "profiles" / profile / "config.yaml"

    if not config_path.is_file():
        return None
    try:
        cfg = yaml.safe_load(config_path.read_text()) or {}
    except Exception:
        return None

    model_cfg = cfg.get("model")
    if isinstance(model_cfg, str):
        return model_cfg
    if isinstance(model_cfg, dict):
        return model_cfg.get("default") or model_cfg.get("model")
    return None


def _parse_session_id(stderr: str) -> Optional[str]:
    match = _SESSION_ID_RE.search(stderr)
    return match.group(1).strip() if match else None


def run_hermes_turn(
    hermes_bin: str,
    profile: str,
    query: str,
    *,
    resume: Optional[str] = None,
    timeout_s: float = 120.0,
) -> TurnResult:
    """Run a single non-interactive hermes chat turn as a subprocess.

    Mechanism: ``hermes -p <profile> chat -q "<query>" -Q [--resume <id>]``.
    ``-p``/``--profile`` is pre-argparse (hermes_cli/main.py's
    `_apply_profile_override`, confirmed by reading it directly) and is
    accepted anywhere in argv outside a `mcp add --args` passthrough region,
    so placing it before the `chat` subcommand is safe. `-Q`/`--quiet`
    (confirmed at hermes_cli/_parser.py's chat subparser) suppresses the
    banner/spinner/tool-previews so stdout is exactly the final response
    text and nothing else; the session_id is written to stderr as
    `session_id: <id>` (confirmed at cli.py's quiet single-query exit path)
    regardless of -Q.
    """
    argv = [hermes_bin, "-p", profile, "chat", "-q", query, "-Q"]
    if resume:
        argv.extend(["--resume", resume])

    start = time.monotonic()
    try:
        completed = subprocess.run(
            argv, capture_output=True, timeout=timeout_s, text=True
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - start
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        return TurnResult(
            stdout=stdout or "",
            stderr=stderr or "",
            returncode=-1,
            session_id=None,
            timed_out=True,
            duration_s=duration,
        )
    except FileNotFoundError as exc:
        # hermes_bin doesn't exist / isn't executable - a clearly-labeled
        # error row for this profile, not a crash that aborts the others.
        duration = time.monotonic() - start
        return TurnResult(
            stdout="",
            stderr=f"{exc}",
            returncode=-2,
            session_id=None,
            timed_out=False,
            duration_s=duration,
        )

    duration = time.monotonic() - start
    return TurnResult(
        stdout=completed.stdout,
        stderr=completed.stderr,
        returncode=completed.returncode,
        session_id=_parse_session_id(completed.stderr),
        timed_out=False,
        duration_s=duration,
    )


def run_profile_turns(
    hermes_bin: str,
    profile: str,
    turns: list[str],
    *,
    timeout_s: float,
) -> tuple[Optional[str], Optional[str], float, Optional[str]]:
    """Run all turns for one profile sequentially, chaining via --resume.

    Returns ``(final_answer, error, total_latency_s, context)``. The moment
    any turn fails, ``error`` is set and remaining turns for THIS profile are
    skipped - failure isolation is per-profile, never global: one bad
    profile (nonexistent, misconfigured, timed out) must not abort the
    others' runs or get silently scored, matching this repo's own
    gate-discipline stance ("errors are errors, not silently swallowed").
    """
    session_id: Optional[str] = None
    final_answer: Optional[str] = None
    total_latency = 0.0
    context_parts: list[str] = []

    for i, turn in enumerate(turns):
        result = run_hermes_turn(
            hermes_bin, profile, turn, resume=session_id, timeout_s=timeout_s
        )
        total_latency += result.duration_s

        if result.timed_out:
            return None, f"timed out after {timeout_s}s on turn {i + 1}/{len(turns)}", total_latency, None
        if result.returncode != 0:
            stderr_lines = [ln for ln in result.stderr.strip().splitlines() if ln.strip()]
            detail = stderr_lines[-1] if stderr_lines else "(no stderr output)"
            return (
                None,
                f"hermes exited {result.returncode} on turn {i + 1}/{len(turns)}: {detail}",
                total_latency,
                None,
            )

        answer = result.stdout.strip()
        if i < len(turns) - 1:
            context_parts.append(f"User: {turn}\nAssistant: {answer}")
        else:
            final_answer = answer
        session_id = result.session_id

    context = "\n\n".join(context_parts) if context_parts else None
    return final_answer, None, total_latency, context


def compare_profiles(
    profiles: list[str],
    turns: list[str],
    *,
    hermes_bin: str = "hermes",
    judge_provider: Optional[str] = None,
    timeout_s: float = 120.0,
    hermes_home: Path = _DEFAULT_HERMES_HOME,
) -> list[ProfileResult]:
    """Run every profile against `turns` and score the final answer.

    A single judge instance is resolved once and shared across all profiles
    (same judge backend for a fair comparison) - resolution failure
    (`NoProviderAvailableError`, e.g. no Ollama/Gemini/Claude backend
    reachable) aborts the whole comparison rather than silently scoring some
    profiles and not others, since without a judge there is nothing to
    compare.
    """
    judge = make_runtime_judge(provider=judge_provider)

    first_turn_prompt = turns[0] if turns else ""
    results: list[ProfileResult] = []

    for profile in profiles:
        model = resolve_profile_model(profile, hermes_home=hermes_home)
        final_answer, error, latency_s, context = run_profile_turns(
            hermes_bin, profile, turns, timeout_s=timeout_s
        )

        if error is not None:
            results.append(
                ProfileResult(profile=profile, model=model, latency_s=latency_s, error=error)
            )
            continue

        judge_result = judge.evaluate(
            prompt=first_turn_prompt, response=final_answer or "", context=context
        )
        results.append(
            ProfileResult(
                profile=profile,
                model=model,
                latency_s=latency_s,
                judge=judge_result,
                final_answer=final_answer,
            )
        )

    return results


def _truncate(text: str, width: int) -> str:
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    return text[: max(0, width - 1)] + "…"


def format_report(results: list[ProfileResult]) -> str:
    """Plain stdlib string table - no `tabulate` dependency, per this
    integration's existing dependency discipline (requirements.txt only
    documents the `mcp` version assumption, nothing else)."""
    headers = [
        "profile", "model", "latency_s", "score", "quality", "safety",
        "tool_use", "personalization", "rationale",
    ]
    rows: list[list[str]] = []
    for r in results:
        if r.error is not None:
            rows.append([r.profile, r.model or "unknown", "-", "ERROR", "-", "-", "-", "-", r.error])
            continue
        j = r.judge
        assert j is not None  # invariant: only unset when error is set
        rows.append(
            [
                r.profile,
                r.model or "unknown",
                f"{r.latency_s:.2f}" if r.latency_s is not None else "-",
                f"{j.score:.3f}",
                f"{j.quality:.3f}",
                f"{j.safety:.3f}",
                f"{j.tool_use:.3f}",
                f"{j.personalization:.3f}",
                _truncate(j.rationale, 60),
            ]
        )

    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    def _fmt_row(cells: list[str]) -> str:
        return "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    lines = [_fmt_row(headers), _fmt_row(["-" * w for w in widths])]
    lines.extend(_fmt_row(row) for row in rows)
    return "\n".join(lines)


def _results_to_json(results: list[ProfileResult]) -> list[dict]:
    out = []
    for r in results:
        entry: dict = {
            "profile": r.profile,
            "model": r.model,
            "latency_s": r.latency_s,
            "error": r.error,
            "final_answer": r.final_answer,
        }
        if r.judge is not None:
            entry["judge"] = {
                "score": r.judge.score,
                "quality": r.judge.quality,
                "safety": r.judge.safety,
                "tool_use": r.judge.tool_use,
                "personalization": r.judge.personalization,
                "rationale": r.judge.rationale,
                "is_parse_error": r.judge.is_parse_error,
            }
        out.append(entry)
    return out


def _load_turns(args: argparse.Namespace) -> list[str]:
    if args.conversation:
        data = json.loads(Path(args.conversation).read_text())
        if not isinstance(data, list) or not all(isinstance(t, str) for t in data):
            raise ValueError(f"{args.conversation} must contain a JSON list[str] of user turns")
        if not data:
            raise ValueError(f"{args.conversation} is an empty turn list")
        return data
    if args.prompt:
        return [args.prompt]
    raise ValueError("one of --prompt or --conversation is required")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "A/B/n compare Hermes model profiles on a shared prompt or "
            "conversation, scored by Deus's judge harness."
        )
    )
    parser.add_argument(
        "--profiles",
        required=True,
        help="Comma-separated list of existing Hermes profile names to compare.",
    )
    prompt_group = parser.add_mutually_exclusive_group(required=True)
    prompt_group.add_argument("--prompt", help="Single-shot prompt to send to every profile.")
    prompt_group.add_argument(
        "--conversation",
        help="Path to a JSON list[str] of user turns, replayed in order per profile.",
    )
    parser.add_argument(
        "--judge-provider",
        default=None,
        help="Judge backend to use (e.g. ollama, gemini). Default: auto-detect via JudgeRegistry.",
    )
    parser.add_argument(
        "--timeout", type=float, default=120.0, help="Per hermes-invocation timeout, in seconds."
    )
    parser.add_argument(
        "--hermes-bin", default="hermes", help="Override the hermes executable to invoke."
    )
    parser.add_argument(
        "--hermes-home",
        default=None,
        help="Override ~/.hermes for profile config resolution (report display only).",
    )
    parser.add_argument("--json", default=None, help="Optional path to dump raw results as JSON.")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        parser.error("--profiles must name at least one profile")

    try:
        turns = _load_turns(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
        return 2  # unreachable, parser.error() exits - keeps type-checkers happy

    hermes_home = Path(args.hermes_home).expanduser() if args.hermes_home else _DEFAULT_HERMES_HOME

    try:
        results = compare_profiles(
            profiles,
            turns,
            hermes_bin=args.hermes_bin,
            judge_provider=args.judge_provider,
            timeout_s=args.timeout,
            hermes_home=hermes_home,
        )
    except NoProviderAvailableError as exc:
        print(f"Error: no judge provider available: {exc}", file=sys.stderr)
        return 1

    print(format_report(results))

    if args.json:
        Path(args.json).write_text(json.dumps(_results_to_json(results), indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
