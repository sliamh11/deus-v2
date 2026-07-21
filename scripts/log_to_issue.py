#!/usr/bin/env python3
"""Convert Deus-v2 runtime errors into GitHub issue stubs (LIA-453 Phase 2).

Reads ~/deus-v2-mvp/logs/deus.error.log, filters level>=40 (pino) + classified
stderr events, dedupes by normalized fingerprint, and opens a stub GH issue
per unique fingerprint against sliamh11/deus-v2. This is a wholesale reuse of
v1's `~/.config/deus/scripts/log_to_issue.py` mechanism (fingerprinting,
dedupe, PII-scrub, gh-CLI calls) — nothing about the dedupe/scrub logic is
redesigned here, only the repo target and every hardcoded state/lock path.

Isolation: v1's script hardcodes four ~/.config/deus/... path constants
(STATE_PATH, CONFIG_PATH, DETAILS_DIR, LOCK_PATH) plus a ~/deus/logs source
log path. All are re-pointed below at v2's own tree (~/.config/deus-v2/... and
~/deus-v2-mvp/logs/...). LOCK_PATH is the one that actually matters for
correctness, not just hygiene: acquire_lock() exits 0 *silently* when another
PID already holds the lock (by design, so a healthy skip never looks like a
launchd crash) — if v2 kept v1's lock file path, v1's and v2's log-to-issue
jobs would share one lock, and whichever fires first on an overlapping
schedule would silently no-op the other indefinitely, with zero error signal.

The sliamh11/deus-v2 repo is public, so nothing from the log body reaches
the wire: issue titles/bodies contain only fingerprint, allow-listed
err_type, timestamps, source, level, and occurrence count.
"""
from __future__ import annotations

import argparse
import atexit
import fcntl
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HOME = Path.home()
# LIA-453: v2's own daemon deploys from ~/deus-v2-mvp (confirmed live-host
# checkout, distinct from v1's ~/deus) and writes its error log at the same
# projectRoot/logs/deus.error.log path setup/service.ts wires up for it.
LOG_PATH = HOME / "deus-v2-mvp/logs/deus.error.log"
STATE_PATH = HOME / ".config/deus-v2/log_to_issue_state.json"
CONFIG_PATH = HOME / ".config/deus-v2/log_to_issue_config.json"
DETAILS_DIR = HOME / ".config/deus-v2/log_to_issue_details"
LOCK_PATH = HOME / ".config/deus-v2/log_to_issue.lock"
REPO = "sliamh11/deus-v2"
ASSIGNEE = "sliamh11"
STATE_VERSION = 1

# err_type allowlist is UNION of hardcoded baseline + config extras.
# Config can only ADD (union), never subtract — invariant enforced in
# safe_err_type below. Anything not in the union becomes "UnknownError"
# before reaching the wire. Fingerprint still uses the raw class name
# locally so dedupe quality is preserved.
_ERR_TYPE_ALLOWLIST = frozenset({
    "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
    "URIError", "EvalError", "AggregateError",
    "SystemError", "AssertionError", "NodeWarning",
    "MaxListenersExceededWarning", "DeprecationWarning",
    "RetryableError", "UserError", "FatalError", "DeusError",
    "OperationalError", "ProgrammerError", "ExternalError",
    "StderrText", "DanglingStackFrame",
    "UnknownError",
})

# Any key in this set is dropped at any nesting depth before the object
# is touched for wire serialization. "type" and "name" are dropped so
# custom class names cannot leak via nested error objects — safe_err_type
# handles the allowlist gate separately on a pre-drop extract.
_DROP_KEYS = frozenset({
    # content
    "content", "text", "body", "quoted", "caption", "message",
    "participant", "from", "to", "sender", "receiver", "recipient",
    "chat", "chatId", "remoteJid", "fromMe", "pushName", "notifyName",
    "vcard", "media",
    # class names
    "type", "name",
    # nested causes
    "cause", "inner", "originalError",
    # OAuth / auth
    "response", "request", "headers", "authorization", "token",
    "access_token", "refresh_token", "id_token", "apiKey", "api_key",
    "bearer",
    # Baileys / libsignal
    "reason", "code", "data", "payload", "meta", "extras", "details",
})

_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b\d{7,15}(?:-\d+)?@(?:s\.whatsapp\.net|g\.us|lid|broadcast)\b"), "<wa-jid>"),
    (re.compile(r"\+?\d{7,15}\b"), "<phone>"),
    (re.compile(r'\btg(?:_chat)?_id[=:\s"]+-?\d{6,}'), "tg_chat_id=<tg-id>"),
    (re.compile(r"(?<![A-Za-z0-9_])-?100\d{10,13}(?![A-Za-z0-9_])"), "<tg-id>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(re.escape(str(HOME)) + r"(/[^\s\"':,)\]}]*)?"), r"~\1"),
    (re.compile(r"\b(?:3EB0|BAE5|[0-9A-F]{4})[0-9A-F]{12,}\b"), "<msg-id>"),
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    (re.compile(r'\b(?:pid[=:\s"]+|node:)\d{1,7}\b'), "pid=<pid>"),
    (re.compile(r"\b1[6-9]\d{11}\b"), "<ts>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?\b"), "<ts>"),
    (re.compile(r"\b0x[0-9a-fA-F]{6,}\b"), "<addr>"),
    (re.compile(r":\d{4,5}\b"), ":<port>"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"), "<redacted-key>"),
    (re.compile(r"\bya29\.[A-Za-z0-9_\-]{20,}\b"), "<redacted-key>"),
    (re.compile(r"\b[0-9a-f]{40}\b"), "<redacted-token>"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+"), "bearer <redacted>"),
]


def normalize(s: str) -> str:
    if not s:
        return ""
    for rx, repl in _PATTERNS:
        s = rx.sub(repl, s)
    return s.strip()


def normalize_stack(stack: str) -> str:
    if not stack:
        return ""
    return "\n".join(normalize(line) for line in stack.splitlines())


def top_frames(stack: str, n: int = 3) -> tuple[str, ...]:
    if not stack:
        return ()
    frames = [ln.strip() for ln in stack.splitlines() if ln.strip().startswith("at ")]
    return tuple(normalize(f) for f in frames[:n])


def deep_drop(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: deep_drop(v) for k, v in obj.items() if k not in _DROP_KEYS}
    if isinstance(obj, list):
        return [deep_drop(x) for x in obj]
    return obj


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception as e:
        print(f"config load failed: {e}", file=sys.stderr)
        return {}


def safe_err_type(raw: str | None) -> str:
    if not raw:
        return "UnknownError"
    extra = set(load_config().get("allowed_err_types", []))
    if raw in _ERR_TYPE_ALLOWLIST or raw in extra:
        return raw
    return "UnknownError"


@dataclass
class Event:
    fp_err_type: str          # raw class name for fingerprint (local only)
    wire_err_type: str        # allow-listed class name for GH
    err_msg: str              # normalized, local only
    stack: str                # normalized, local only
    top_frames: tuple[str, ...]
    level: int
    ts: int                   # epoch seconds
    source: str               # "pino" or "stderr"


def event_from_pino(obj: dict) -> Event | None:
    level = int(obj.get("level", 0))
    if level < 40:
        return None
    err = obj.get("err") or {}
    raw_type = err.get("type") or obj.get("type") or obj.get("name")
    safe = deep_drop(obj)
    safe_err = safe.get("err") or {}
    err_msg = normalize(safe_err.get("message") or safe.get("msg") or "")
    stack = normalize_stack(safe_err.get("stack") or "")
    ts_ms = int(obj.get("time", 0))
    ts = ts_ms // 1000 if ts_ms > 10**12 else ts_ms
    return Event(
        fp_err_type=raw_type or "<unknown>",
        wire_err_type=safe_err_type(raw_type),
        err_msg=err_msg,
        stack=stack,
        top_frames=top_frames(stack),
        level=level,
        ts=ts or int(time.time()),
        source="pino",
    )


_NODE_WARN_RE = re.compile(r"^\(node:\d+\)\s+(\[[^\]]+\]\s+)?(\w+Warning):\s*(.*)")
_ERR_LINE_RE = re.compile(r"^(\w+Error):\s*(.*)")


def event_from_stderr(lines: list[str]) -> Event | None:
    if not lines:
        return None
    head = lines[0]
    stack_lines = [ln for ln in lines if ln.lstrip().startswith("at ")]
    stack = "\n".join(stack_lines)
    first_nonstack = next((ln for ln in lines if not ln.lstrip().startswith("at ")), head)
    level = 40
    if m := _NODE_WARN_RE.match(head):
        raw_type = m.group(2)
        msg = m.group(3)
    elif m := _ERR_LINE_RE.match(head):
        raw_type = m.group(1)
        msg = m.group(2)
        level = 50
    elif head.lstrip().startswith("at "):
        raw_type = "DanglingStackFrame"
        msg = head
    else:
        raw_type = "StderrText"
        msg = first_nonstack
    if "FATAL" in head.upper() or "UNCAUGHT" in head.upper():
        level = 60
    norm_msg = normalize(msg)
    norm_stack = normalize_stack(stack)
    return Event(
        fp_err_type=raw_type,
        wire_err_type=safe_err_type(raw_type),
        err_msg=norm_msg,
        stack=norm_stack,
        top_frames=top_frames(norm_stack),
        level=level,
        ts=int(time.time()),
        source="stderr",
    )


def fingerprint(ev: Event) -> str:
    key = json.dumps(
        (ev.fp_err_type, ev.err_msg, list(ev.top_frames)),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(key).hexdigest()[:16]


def stream_events(path: Path, start_inode: int, start_offset: int):
    if not path.exists():
        return [], start_offset, start_inode
    st = path.stat()
    cur_inode = st.st_ino
    cur_size = st.st_size
    offset = start_offset
    if cur_inode != start_inode or cur_size < start_offset:
        if start_inode != 0:
            print(
                f"log rotation/truncation detected "
                f"(inode {start_inode}->{cur_inode}, size {cur_size} vs offset {start_offset}); "
                f"reading from byte 0",
                file=sys.stderr,
            )
        offset = 0
    events: list[Event] = []
    with path.open("rb") as f:
        f.seek(offset)
        buf: list[str] = []
        for raw in f:
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            if line.startswith("{"):
                if buf:
                    ev = event_from_stderr(buf)
                    if ev:
                        events.append(ev)
                    buf = []
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    buf.append(line)
                    continue
                ev = event_from_pino(obj)
                if ev:
                    events.append(ev)
            else:
                if line.strip():
                    buf.append(line)
        if buf:
            ev = event_from_stderr(buf)
            if ev:
                events.append(ev)
        new_offset = f.tell()
    return events, new_offset, cur_inode


def atomic_write(path: Path, data: str) -> None:
    d = path.parent
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix=".state.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {
            "version": STATE_VERSION,
            "cursor": {"inode": 0, "offset": 0, "path": str(LOG_PATH)},
            "bootstrapped_at": 0,
            "errors": {},
        }
    try:
        s = json.loads(STATE_PATH.read_text())
    except Exception as e:
        print(f"state file corrupt: {e}", file=sys.stderr)
        raise SystemExit(2)
    if s.get("version") != STATE_VERSION:
        print(f"state version mismatch: {s.get('version')} vs {STATE_VERSION}", file=sys.stderr)
        raise SystemExit(2)
    return s


def save_state(state: dict) -> None:
    atomic_write(STATE_PATH, json.dumps(state, indent=2, sort_keys=True))


def acquire_lock() -> None:
    """pid-lockfile with stale-pid detection. Exit 0 (not 2) when contended
    so launchd doesn't flag a healthy skip as a crash."""
    if LOCK_PATH.exists():
        try:
            pid = int(LOCK_PATH.read_text().strip() or "0")
        except ValueError:
            pid = 0
        if pid > 0:
            try:
                os.kill(pid, 0)
                print(f"prior run pid={pid} still active; skipping", file=sys.stderr)
                sys.exit(0)
            except ProcessLookupError:
                pass  # stale
            except PermissionError:
                print(f"prior run pid={pid} owned by another user; skipping", file=sys.stderr)
                sys.exit(0)
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(str(os.getpid()))
    atexit.register(lambda: LOCK_PATH.unlink(missing_ok=True))


def gh(args: list[str], stdin: str | None = None) -> str:
    r = subprocess.run(
        ["gh", *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if r.returncode != 0:
        sys.stderr.write(f"gh {args[0]} failed rc={r.returncode}: {r.stderr}\n")
        raise SystemExit(2)
    return r.stdout


def gh_try(args: list[str], stdin: str | None = None) -> str | None:
    r = subprocess.run(
        ["gh", *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return r.stdout if r.returncode == 0 else None


def ensure_labels() -> None:
    gh_try(["label", "create", "runtime-error", "--repo", REPO,
            "--color", "B60205", "--description", "Auto-filed runtime error"])
    gh_try(["label", "create", "auto-reported", "--repo", REPO,
            "--color", "C5DEF5", "--description", "Opened by automation"])


def iso(ts: int) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))


def issue_title(ev: Event, fp: str) -> str:
    return f"runtime[{ev.source}]: {ev.wire_err_type} {fp[:8]}"


def issue_body(ev: Event, fp: str, count: int) -> str:
    return (
        "**Auto-reported runtime error (stub only — details stay local)**\n\n"
        f"- Fingerprint: `{fp}`\n"
        f"- Source: `{ev.source}` (level {ev.level})\n"
        f"- Error class (allow-listed): `{ev.wire_err_type}`\n"
        f"- First seen: {iso(ev.ts)}\n"
        f"- Occurrences in first batch: {count}\n\n"
        "---\n"
        f"_Filed by `log_to_issue.py`. Message text, stack frames, and any "
        f"pino fields are NOT uploaded — this repo is public. Full scrubbed "
        f"details are in `~/.config/deus-v2/log_to_issue_details/{fp}.json` on "
        f"the host. Additional occurrences are throttled to one comment/24h._"
    )


def write_sidecar(fp: str, ev: Event, count: int) -> None:
    DETAILS_DIR.mkdir(parents=True, exist_ok=True)
    path = DETAILS_DIR / f"{fp}.json"
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except Exception:
            existing = {}
    samples = existing.get("samples", [])
    samples.append({
        "ts": ev.ts,
        "level": ev.level,
        "source": ev.source,
        "fp_err_type": ev.fp_err_type,
        "err_msg": ev.err_msg,
        "top_frames": list(ev.top_frames),
    })
    samples = samples[-10:]
    data = {
        "fingerprint": fp,
        "fp_err_type": ev.fp_err_type,
        "wire_err_type": ev.wire_err_type,
        "first_seen": existing.get("first_seen", ev.ts),
        "last_seen": ev.ts,
        "count": count,
        "samples": samples,
    }
    blob = json.dumps(data, indent=2, sort_keys=True)
    if len(blob) > 32 * 1024:
        with gzip.open(str(path) + ".gz", "wt") as f:
            f.write(blob)
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, blob)


def create_issue(ev: Event, fp: str, count: int, dry_run: bool) -> int:
    title = issue_title(ev, fp)
    body = issue_body(ev, fp, count)
    if dry_run:
        print(f"[DRY] create-issue fp={fp} title={title!r}")
        return -2
    out = gh([
        "issue", "create",
        "--repo", REPO,
        "--title", title,
        "--body", body,
        "--label", "runtime-error",
        "--label", "auto-reported",
    ])
    num = int(re.search(r"/issues/(\d+)", out).group(1))
    gh_try(["issue", "edit", str(num), "--repo", REPO,
            "--add-assignee", ASSIGNEE])
    return num


def comment_issue(num: int, count: int, ts: int, dry_run: bool) -> None:
    body = f"Still happening. Count: {count}. Last seen: {iso(ts)}."
    if dry_run:
        print(f"[DRY] comment issue={num} body={body!r}")
        return
    gh(["issue", "comment", str(num), "--repo", REPO, "--body", body])


def issue_state(num: int) -> str:
    out = gh_try(["issue", "view", str(num), "--repo", REPO, "--json", "state"])
    if not out:
        return "unknown"
    try:
        return json.loads(out).get("state", "unknown").lower()
    except Exception:
        return "unknown"


def reopen_issue(num: int, dry_run: bool) -> None:
    if dry_run:
        print(f"[DRY] reopen issue={num}")
        return
    gh_try(["issue", "reopen", str(num), "--repo", REPO])


def print_histogram(groups: dict[str, list[Event]], actions: dict[str, str]) -> None:
    rows = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    print(f"{'fp':10} {'src':7} {'type':22} {'count':>6}  action")
    print("-" * 60)
    totals = {"CREATE": 0, "COMMENT": 0, "SKIP": 0, "DEFER": 0}
    for fp, evs in rows:
        ev = evs[0]
        act = actions.get(fp, "SKIP")
        totals[act] = totals.get(act, 0) + 1
        print(f"{fp[:8]:10} {ev.source:7} {ev.wire_err_type[:22]:22} {len(evs):>6}  {act}")
    print("-" * 60)
    total_events = sum(len(v) for v in groups.values())
    print(
        f"total: {len(groups)} fingerprints, {total_events} events, "
        + ", ".join(f"{v} would-{k}" for k, v in totals.items() if v)
    )


def run(
    bootstrap: bool = False,
    force: bool = False,
    dry_run: bool = False,
    verbose: bool = False,
    fixture: Path | None = None,
) -> int:
    cfg = load_config()
    max_creates = int(cfg.get("max_creates_per_run", 5))
    max_bootstrap = int(cfg.get("max_bootstrap_creates", 20))
    if bootstrap:
        max_creates = max_bootstrap
    min_level = int(cfg.get("min_level", 40))
    ignore_rules = cfg.get("ignore", [])

    if fixture:
        log_path = fixture
        state = {
            "version": STATE_VERSION,
            "cursor": {"inode": 0, "offset": 0, "path": str(log_path)},
            "bootstrapped_at": 0,
            "errors": {},
        }
        dry_run = True
    else:
        log_path = LOG_PATH
        state = load_state()
        if bootstrap and state.get("bootstrapped_at") and not force:
            print("already bootstrapped; use --force to re-run", file=sys.stderr)
            return 2

    cursor = state["cursor"]
    start_inode = 0 if bootstrap else int(cursor.get("inode", 0))
    start_offset = 0 if bootstrap else int(cursor.get("offset", 0))

    events, new_offset, new_inode = stream_events(log_path, start_inode, start_offset)
    if min_level > 40:
        events = [e for e in events if e.level >= min_level]
    events = [e for e in events if not is_ignored(e, ignore_rules)]

    groups: dict[str, list[Event]] = {}
    for ev in events:
        groups.setdefault(fingerprint(ev), []).append(ev)

    errors = state.setdefault("errors", {})
    actions: dict[str, str] = {}
    created = 0
    now = int(time.time())

    for fp, evs in groups.items():
        first_ev = evs[0]
        last_ev = evs[-1]
        entry = errors.get(fp)

        if bootstrap and entry is None:
            # During bootstrap, sentinel everything: we cannot date stderr
            # events reliably (they have no ts), and the whole point is to
            # avoid retroactively spamming the tracker. Forward runs file
            # anything new.
            errors[fp] = {
                "issue_number": -1,
                "first_seen_ts": first_ev.ts,
                "last_seen_ts": last_ev.ts,
                "count": len(evs),
                "last_comment_ts": 0,
                "err_type": first_ev.wire_err_type,
                "err_msg_preview": first_ev.err_msg[:80],
                "sentinel": "pre-bootstrap",
            }
            actions[fp] = "SKIP"
            if not dry_run:
                save_state(state)
            continue

        if entry is None:
            if created >= max_creates:
                errors[fp] = {
                    "issue_number": 0,
                    "first_seen_ts": first_ev.ts,
                    "last_seen_ts": last_ev.ts,
                    "count": len(evs),
                    "last_comment_ts": 0,
                    "err_type": first_ev.wire_err_type,
                    "err_msg_preview": first_ev.err_msg[:80],
                    "sentinel": "deferred",
                }
                actions[fp] = "DEFER"
                if not dry_run:
                    save_state(state)
                continue
            num = create_issue(first_ev, fp, len(evs), dry_run)
            actions[fp] = "CREATE"
            created += 1
            errors[fp] = {
                "issue_number": num,
                "first_seen_ts": first_ev.ts,
                "last_seen_ts": last_ev.ts,
                "count": len(evs),
                "last_comment_ts": last_ev.ts,
                "err_type": first_ev.wire_err_type,
                "err_msg_preview": first_ev.err_msg[:80],
            }
            if not dry_run:
                write_sidecar(fp, first_ev, len(evs))
                save_state(state)
            if bootstrap:
                time.sleep(0.2)
            continue

        # known fingerprint
        entry["count"] = int(entry.get("count", 0)) + len(evs)
        entry["last_seen_ts"] = last_ev.ts
        if entry.get("sentinel") in ("pre-bootstrap", "deferred"):
            actions[fp] = "SKIP"
            if not dry_run:
                save_state(state)
            continue
        num = int(entry.get("issue_number", 0))
        if num > 0:
            if issue_state(num) == "closed":
                reopen_issue(num, dry_run)
            if last_ev.ts - int(entry.get("last_comment_ts", 0)) >= 86400:
                comment_issue(num, entry["count"], last_ev.ts, dry_run)
                entry["last_comment_ts"] = last_ev.ts
                actions[fp] = "COMMENT"
            else:
                actions[fp] = "SKIP"
        if not dry_run:
            write_sidecar(fp, last_ev, entry["count"])
            save_state(state)

    state["cursor"] = {"inode": new_inode, "offset": new_offset, "path": str(log_path)}
    if bootstrap:
        state["bootstrapped_at"] = now
    if not dry_run:
        save_state(state)

    if dry_run and not verbose:
        print_histogram(groups, actions)
    elif dry_run and verbose:
        for fp, evs in groups.items():
            print(f"[DRY] fp={fp} source={evs[0].source} type={evs[0].wire_err_type} "
                  f"count={len(evs)} action={actions.get(fp, 'SKIP')}")

    return 0


def is_ignored(ev: Event, rules: list[dict]) -> bool:
    for rule in rules:
        if t := rule.get("err_type_eq"):
            if ev.wire_err_type != t and ev.fp_err_type != t:
                continue
        if s := rule.get("msg_contains"):
            if s not in ev.err_msg:
                continue
        return True
    return False


def reset_fingerprint(fp: str) -> int:
    state = load_state()
    errors = state.get("errors", {})
    if fp not in errors:
        print(f"fp {fp} not in state", file=sys.stderr)
        return 1
    del errors[fp]
    save_state(state)
    try:
        (DETAILS_DIR / f"{fp}.json").unlink(missing_ok=True)
        (DETAILS_DIR / f"{fp}.json.gz").unlink(missing_ok=True)
    except OSError:
        pass
    print(f"reset {fp}")
    return 0


def print_fingerprint_from_stdin() -> int:
    raw = sys.stdin.read()
    try:
        obj = json.loads(raw)
        ev = event_from_pino(obj)
    except json.JSONDecodeError:
        ev = event_from_stderr([ln for ln in raw.splitlines() if ln.strip()])
    if not ev:
        print("no event extracted", file=sys.stderr)
        return 1
    fp = fingerprint(ev)
    print(f"{fp}\t{ev.wire_err_type}\t{ev.err_msg[:120]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--fixture", type=Path, default=None)
    ap.add_argument("--reset-fingerprint", type=str, default=None)
    ap.add_argument("--print-fingerprint", action="store_true")
    args = ap.parse_args()

    if args.print_fingerprint:
        return print_fingerprint_from_stdin()
    if args.reset_fingerprint:
        return reset_fingerprint(args.reset_fingerprint)

    if not args.dry_run and not args.fixture:
        acquire_lock()
        ensure_labels()

    return run(
        bootstrap=args.bootstrap,
        force=args.force,
        dry_run=args.dry_run,
        verbose=args.verbose,
        fixture=args.fixture,
    )


if __name__ == "__main__":
    sys.exit(main())
