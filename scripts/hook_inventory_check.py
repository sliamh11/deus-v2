#!/usr/bin/env python3
"""Completeness check for docs/exec-plans/active/EP-001-hook-inventory-extraction.md
(LIA-414).

That artifact is a *living* inventory of every Claude Code hook dispatch
declared in this repo's own `.claude/settings.json`, mapped to a deus-native
middleware/lifecycle slot with a port / port-later / drop-with-reason
disposition. Living artifacts drift: someone edits `.claude/settings.json`
(adds/removes a hook, changes a matcher) and forgets to update the inventory
table to match.

This script re-extracts the dispatch list fresh from the live
`.claude/settings.json` (the same JSON structure the harness itself reads)
and compares it -- by count AND by identity -- against the dispatch rows
parsed out of the inventory artifact's own markdown table. It does not
duplicate the mapping data anywhere: the artifact's table is the sole source
of the intended mapping, this script is the sole source of the live
extraction, and the two are diffed against each other.

Exit codes:
  0 -- artifact and live settings.json agree (same count, same identities)
  1 -- drift detected (see printed diff)
  2 -- could not parse one of the two inputs (path missing, bad JSON, bad table)

Usage:
  python3 scripts/hook_inventory_check.py
  python3 scripts/hook_inventory_check.py --settings <path> --artifact <path>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SETTINGS = PROJECT_ROOT / ".claude" / "settings.json"
DEFAULT_ARTIFACT = (
    PROJECT_ROOT
    / "docs"
    / "exec-plans"
    / "active"
    / "EP-001-hook-inventory-extraction.md"
)

# Matches "warden-shim.sh" (possibly preceded by an escaped quote) followed by
# the behavior token passed as its argument, e.g.:
#   ".../warden-shim.sh\" session-init"
#   ".../warden-shim.sh' plan-review-gate"
_WARDEN_SHIM_RE = re.compile(r"warden-shim\.sh['\"]?\s+([\w-]+)")

# Matches a bare script filename (.sh or .py) anywhere in the command string,
# used for hooks invoked directly rather than through warden-shim.sh.
_SCRIPT_NAME_RE = re.compile(r"([\w.-]+\.(?:sh|py))")


class DispatchKey:
    """One (event, matcher, identity) triple -- the unit LIA-414 calls a
    'dispatch'. Two rows with the same event+identity but different matchers
    (e.g. codegraph-first-gate on both the Bash and Grep|Glob PreToolUse
    blocks) are two distinct dispatches, matching the ticket's own
    "codegraph-first-gate x2 matchers" phrasing."""

    __slots__ = ("event", "matcher", "identity")

    def __init__(self, event: str, matcher: str, identity: str) -> None:
        self.event = event
        self.matcher = matcher
        self.identity = identity

    def key(self) -> tuple[str, str, str]:
        return (self.event, self.matcher, self.identity)

    def __repr__(self) -> str:
        m = self.matcher or "—"
        return f"{self.event}/{m}/{self.identity}"


def _derive_identity(command: str) -> str:
    """Extracts a stable identity string from one hook's `command` field.

    Prefers the warden-shim.sh behavior name (e.g. "plan-review-gate") since
    that is what `scripts/codex_warden_hooks.py`'s RUNNERS table keys off of.
    Falls back to the invoked script's basename (e.g. "tdd-test-lock.sh",
    "linear_pending_hook.py") for hooks that bypass the shim.
    """
    shim_match = _WARDEN_SHIM_RE.search(command)
    if shim_match:
        return shim_match.group(1)

    script_names = [
        name for name in _SCRIPT_NAME_RE.findall(command) if name != "warden-shim.sh"
    ]
    if script_names:
        return script_names[-1]

    raise ValueError(f"could not derive an identity from command: {command!r}")


def extract_live_dispatches(settings_path: Path) -> list[DispatchKey]:
    data = json.loads(settings_path.read_text(encoding="utf-8"))
    hooks = data.get("hooks", {})
    dispatches: list[DispatchKey] = []
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for group in groups:
            matcher = str(group.get("matcher") or "")
            for hook in group.get("hooks", []):
                command = str(hook.get("command", ""))
                identity = _derive_identity(command)
                dispatches.append(DispatchKey(event, matcher, identity))
    return dispatches


# One markdown table row, tolerant of backslash-escaped pipes inside a cell
# (needed for matcher values like `Grep\|Glob`).
_ROW_RE = re.compile(r"^\|(.+)\|\s*$")

# Extracts the first backtick-quoted span in a cell, e.g. "`Bash`" -> "Bash",
# or "`codegraph-first-gate` (second matcher)" -> "codegraph-first-gate".
# Falls back to the whole (trimmed) cell when there is no backtick span.
_BACKTICK_SPAN_RE = re.compile(r"`([^`]*)`")

# Matcher/identity cell values meaning "no matcher" -- an em dash placeholder,
# a bare hyphen, or the literal empty-string matcher `""` some hooks use.
_EMPTY_MATCHER_VALUES = {"", "—", "-", '""'}


def _split_row(line: str) -> list[str]:
    # Split on unescaped '|' only, then unescape '\|' -> '|' in each cell.
    raw_cells = re.split(r"(?<!\\)\|", line)
    return [cell.replace("\\|", "|").strip() for cell in raw_cells]


def _cell_value(cell: str) -> str:
    """Unwraps a markdown table cell's primary value: the first backtick span
    if present, else the cell text as-is."""
    m = _BACKTICK_SPAN_RE.search(cell)
    return m.group(1).strip() if m else cell.strip()


def extract_artifact_dispatches(artifact_path: Path) -> list[DispatchKey]:
    lines = artifact_path.read_text(encoding="utf-8").splitlines()
    dispatches: list[DispatchKey] = []
    in_table = False
    header_seen = False
    for line in lines:
        stripped = line.strip()
        m = _ROW_RE.match(stripped)
        if not m:
            in_table = False
            header_seen = False
            continue
        cells = _split_row(m.group(1))
        # Only the dispatch-inventory table has this exact header shape.
        if not header_seen:
            header_seen = True
            in_table = (
                len(cells) >= 6
                and cells[1].lower() == "event"
                and cells[2].lower() == "matcher"
            )
            continue
        if not in_table:
            continue
        # Skip the '---|---|...' separator row.
        if all(re.fullmatch(r":?-+:?", c) for c in cells if c):
            continue
        if len(cells) < 4:
            continue
        event = _cell_value(cells[1])
        matcher_raw = _cell_value(cells[2])
        matcher = "" if matcher_raw in _EMPTY_MATCHER_VALUES else matcher_raw
        identity = _cell_value(cells[3])
        dispatches.append(DispatchKey(event, matcher, identity))
    return dispatches


def _summarize(dispatches: list[DispatchKey]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for d in dispatches:
        counts[d.event] = counts.get(d.event, 0) + 1
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    args = parser.parse_args(argv)

    if not args.settings.is_file():
        print(f"ERROR: settings file not found: {args.settings}", file=sys.stderr)
        return 2
    if not args.artifact.is_file():
        print(f"ERROR: artifact file not found: {args.artifact}", file=sys.stderr)
        return 2

    try:
        live = extract_live_dispatches(args.settings)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: failed to parse {args.settings}: {exc}", file=sys.stderr)
        return 2

    try:
        artifact = extract_artifact_dispatches(args.artifact)
    except ValueError as exc:
        print(f"ERROR: failed to parse {args.artifact}: {exc}", file=sys.stderr)
        return 2

    if not artifact:
        print(
            f"ERROR: found zero dispatch rows in {args.artifact} -- "
            "table header may have changed shape",
            file=sys.stderr,
        )
        return 2

    live_keys = [d.key() for d in live]
    artifact_keys = [d.key() for d in artifact]

    live_set = set(live_keys)
    artifact_set = set(artifact_keys)

    only_live = sorted(live_set - artifact_set)
    only_artifact = sorted(artifact_set - live_set)
    count_ok = len(live_keys) == len(artifact_keys)
    identities_ok = not only_live and not only_artifact

    print(f"live settings.json dispatches:  {len(live_keys)}  {_summarize(live)}")
    print(
        f"artifact table dispatches:      {len(artifact_keys)}  {_summarize(artifact)}"
    )

    if count_ok and identities_ok:
        print("OK: hook inventory artifact matches live .claude/settings.json")
        return 0

    print(
        "DRIFT: hook inventory artifact no longer matches live .claude/settings.json",
        file=sys.stderr,
    )
    if only_live:
        print(
            "  in .claude/settings.json but missing from the artifact table:",
            file=sys.stderr,
        )
        for event, matcher, identity in only_live:
            print(f"    - {event}/{matcher or '(none)'}/{identity}", file=sys.stderr)
    if only_artifact:
        print(
            "  in the artifact table but not in live .claude/settings.json:",
            file=sys.stderr,
        )
        for event, matcher, identity in only_artifact:
            print(f"    - {event}/{matcher or '(none)'}/{identity}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
