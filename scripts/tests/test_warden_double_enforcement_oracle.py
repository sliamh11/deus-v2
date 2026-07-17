"""Independent oracle for LIA-413 — Claude double-enforcement (shadow) mode.

Authored FROM THE SPEC (the approved plan), BLIND to the implementation, BEFORE
any implementation code exists. Its value is independence: the test author is
not the implementer, so the oracle's errors do not correlate with the code's.

What is under test is entirely shim/Python-side:
    .claude/hooks/warden-shim.sh          (live trigger)
    scripts/codex_warden_hooks.py         (the `run` gate + new --correlation-id
                                           / --invocation flags + telemetry)
    scripts/warden_hooks/double_enforcement.py   (new — the launcher/observer)

The mechanism (from the spec):
  * Env switch DEUS_WARDEN_DOUBLE_ENFORCEMENT=1 turns shadow mode on.
  * FLAG OFF  -> byte-for-byte the current two-line `exec ... run "$@" --repo-root`.
  * FLAG ON, event in the shared trigger contract (literal apply_patch OR a
    commit-shaped literal Bash matching GIT_COMMIT_RE):
      1. capture stdin once; mint ONE uuid correlation id (CID);
      2. run the PRIMARY gate synchronously (--correlation-id CID --invocation
         cc-hook --repo-root REPO_ROOT, NO --workspace-root) — this is the ONLY
         output/exit that reaches Claude Code;
      3. launch a detached SECONDARY, observational gate (--correlation-id CID
         --invocation middleware --workspace-root WORKTREE_ROOT), stdout/stderr
         to DEVNULL;
      4. two append-only outcome records (one per invocation) share the CID;
      5. a divergence signal is written by the middleware observer on decision
         or deny-feedback disagreement (and on launch / missing-side failures).
  * FLAG ON, event OUTSIDE the shared contract (Write/Edit/... , non-commit
    Bash): only the original primary runs — NO shadow, NO telemetry.
  * Telemetry bucket derives from event["cwd"] — NEVER from --workspace-root.

RED expectation (pre-implementation): every flag-on test fails because there is
no --correlation-id/--invocation flag, no launcher, and no telemetry file yet.
The two byte-equivalence tests compare the real shim's flag-off path against the
frozen pristine shim (captured from git at the LIA-413 base commit) and fail if
the implementation perturbs the flag-off path.

Run:
    python3 -m pytest scripts/tests/test_warden_double_enforcement_oracle.py -v

Oracle tagging convention (oracle-rules.md § oracle-tagged):
    # @oracle: <one-line spec reference>
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

# Repo root of the code under test: scripts/tests/<this> -> parents[2].
_REPO_UNDER_TEST = Path(__file__).resolve().parents[2]

# The LIA-413 base commit — the shim here is still the pristine two-line exec.
# `git show <sha>:path` resolves for any reachable object, so this stays valid
# after the implementer commits on top (and after a later rebase/merge, as long
# as the commit object survives in the object store).
_BASELINE_SHIM_REF = "ca91bf4429b54aaa628b9c407fe4e8c070a4d279"
_SHIM_RELPATH = ".claude/hooks/warden-shim.sh"

# Spec-defined telemetry file names (append-only JSONL).
_OUTCOME_FILE = ".warden-double-enforce.jsonl"
_DIVERGENCE_FILE = ".warden-double-enforce-divergences.jsonl"

_POLL_TIMEOUT_S = 20.0   # detached secondary is async; poll with a bounded wait.
_POLL_INTERVAL_S = 0.15


# ── Harness ───────────────────────────────────────────────────────────────────
#
# The local dev checkout is a nested git worktree whose git-common-dir points at
# a DIFFERENT repo, so the shim would resolve REPO_ROOT to the wrong tree. To be
# portable (CI standalone clone AND local worktree) every test runs the REAL shim
# inside a self-contained temp git repo that copies scripts/ + the shim, so the
# shim's own git derivation resolves REPO_ROOT to the temp repo and execs the
# deus-v2 script under test. Telemetry/markers stay fully isolated under the temp
# .claude/. Nothing is mocked — the production shim runs as a real subprocess.


@dataclass
class Harness:
    root: Path                 # main repo root (also the "main worktree")
    shim: Path                 # real (working-tree) shim under test
    env_base: dict


def _git(cwd: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-c", "user.email=o@o.co", "-c", "user.name=oracle", *args],
        cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if out.returncode != 0:
        raise RuntimeError(f"git {args} failed: {out.stderr}")
    return out.stdout.strip()


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    root = (tmp_path / "repo").resolve()
    root.mkdir()
    # Copy the code under test. Exclude tests/ + caches for speed; the runtime
    # imports only warden_review/ + warden_hooks/ (subpackages of scripts/).
    shutil.copytree(
        _REPO_UNDER_TEST / "scripts", root / "scripts",
        ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"),
    )
    (root / ".claude" / "hooks").mkdir(parents=True)
    shim = root / _SHIM_RELPATH
    shutil.copy2(_REPO_UNDER_TEST / _SHIM_RELPATH, shim)
    shim.chmod(0o755)

    _git(root, "init", "-q")
    (root / "README").write_text("oracle harness\n")
    _git(root, "add", "README")
    # commit is needed so `git worktree add` works in the two-worktree tests.
    _git(root, "commit", "-q", "-m", "init")

    env = os.environ.copy()
    env.pop("DEUS_WARDEN_DOUBLE_ENFORCEMENT", None)
    env["CLAUDE_PROJECT_DIR"] = str(root)
    return Harness(root=root, shim=shim, env_base=env)


def _apply_patch_event(cwd: Path, rel: str = "src/probe.py") -> dict:
    """A literal apply_patch event — IN the shared trigger contract."""
    return {
        "tool_name": "apply_patch",
        "cwd": str(cwd),
        "tool_input": {"command": f"*** Begin Patch\n*** Add File: {rel}\n+x\n*** End Patch"},
    }


def _commit_bash_event(cwd: Path) -> dict:
    """A commit-shaped literal Bash event — IN the shared trigger contract."""
    return {
        "tool_name": "Bash",
        "cwd": str(cwd),
        "tool_input": {"command": "git commit -m probe"},
    }


def _write_event(cwd: Path, rel: str = "src/probe.py") -> dict:
    """A Write event — OUTSIDE the shared trigger contract."""
    return {
        "tool_name": "Write",
        "cwd": str(cwd),
        "tool_input": {"file_path": str(cwd / rel), "content": "x"},
    }


def _run_shim(
    shim: Path,
    behavior: str,
    event: dict,
    *,
    env_base: dict,
    flag_on: bool,
    project_dir: Path,
    cwd: Path,
) -> subprocess.CompletedProcess:
    """Drive the REAL shim as a subprocess with the event JSON on stdin.

    project_dir -> CLAUDE_PROJECT_DIR, from which the shim derives WORKTREE_ROOT
    (and thus the secondary's --workspace-root). The primary always follows the
    event["cwd"] carried in the JSON.
    """
    env = dict(env_base)
    env["CLAUDE_PROJECT_DIR"] = str(project_dir)
    if flag_on:
        env["DEUS_WARDEN_DOUBLE_ENFORCEMENT"] = "1"
    else:
        env.pop("DEUS_WARDEN_DOUBLE_ENFORCEMENT", None)
    return subprocess.run(
        [str(shim), behavior],
        input=json.dumps(event),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=str(cwd),
    )


def _bucket_dir(repo_root: Path, worktree: Path) -> Path:
    """Spec-defined telemetry bucket for a worktree (mirrors _claude_marker_dir).

    Main worktree (== repo root) -> flat .claude/. Any other worktree ->
    .claude/worktree-markers/<sha1(abspath)[:12]>/. This layout is part of the
    contract (spec 'Telemetry schema' + orchestration-rules), so asserting on it
    is asserting the contract, not an internal detail.
    """
    repo_root = repo_root.resolve()
    worktree = worktree.resolve()
    base = repo_root / ".claude"
    if worktree == repo_root:
        return base
    wt_id = hashlib.sha1(str(worktree).encode()).hexdigest()[:12]
    return base / "worktree-markers" / wt_id


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def _outcomes(bucket: Path) -> list[dict]:
    return _read_jsonl(bucket / _OUTCOME_FILE)


def _divergences(bucket: Path) -> list[dict]:
    return _read_jsonl(bucket / _DIVERGENCE_FILE)


def _wait_for(predicate, timeout: float = _POLL_TIMEOUT_S):
    """Poll until predicate() is truthy (the detached secondary is async)."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(_POLL_INTERVAL_S)
    return last


# ── T1/T2 — flag OFF is a byte-for-byte no-op vs the pristine shim ─────────────
# Acceptance: "the double-enforcement mode remains configurable ... the flag-off
# path is a true, zero-delta no-op." We compare the REAL (post-implementation)
# shim's flag-off output against the frozen pristine shim from the base commit,
# both execing the same copied script, so the ONLY variable is the shim's
# flag-off branch. Any added stdin capture, buffering, extra output, or exit
# perturbation makes the bytes/exit differ.

def _pristine_shim(tmp: Path) -> Path:
    try:
        content = subprocess.run(
            ["git", "show", f"{_BASELINE_SHIM_REF}:{_SHIM_RELPATH}"],
            cwd=str(_REPO_UNDER_TEST), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except OSError as exc:  # pragma: no cover - git absent
        pytest.skip(f"git unavailable for pristine-shim baseline: {exc}")
    if content.returncode != 0:
        pytest.skip(
            f"cannot resolve pristine shim at {_BASELINE_SHIM_REF}: {content.stderr}"
        )
    p = tmp / "warden-shim.baseline.sh"
    p.write_text(content.stdout)
    p.chmod(0o755)
    return p


def test_flag_off_allow_is_byte_identical_to_pristine_shim(harness, tmp_path):
    # @oracle: LIA-413 acceptance — flag-off path is a true zero-delta no-op (allow)
    (harness.root / ".claude" / ".plan-reviewed").touch()   # -> allow (empty stdout)
    event = _apply_patch_event(harness.root)
    base = _pristine_shim(tmp_path)

    ref = _run_shim(base, "plan-review-gate", event, env_base=harness.env_base,
                    flag_on=False, project_dir=harness.root, cwd=harness.root)
    got = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                    flag_on=False, project_dir=harness.root, cwd=harness.root)

    assert got.returncode == ref.returncode, "flag-off exit code drifted from pristine shim"
    assert got.stdout == ref.stdout, "flag-off stdout drifted from pristine shim (allow)"
    assert got.stdout == "", "allow must reach Claude as zero bytes of stdout"


def test_flag_off_deny_is_byte_identical_to_pristine_shim(harness, tmp_path):
    # @oracle: LIA-413 acceptance — flag-off path is a true zero-delta no-op (deny)
    event = _apply_patch_event(harness.root)   # no marker -> deny JSON on stdout
    base = _pristine_shim(tmp_path)

    ref = _run_shim(base, "plan-review-gate", event, env_base=harness.env_base,
                    flag_on=False, project_dir=harness.root, cwd=harness.root)
    got = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                    flag_on=False, project_dir=harness.root, cwd=harness.root)

    assert got.returncode == ref.returncode, "flag-off exit code drifted from pristine shim"
    assert got.stdout == ref.stdout, "flag-off stdout drifted from pristine shim (deny)"
    # sanity: the frozen reference really is a deny (guards a vacuous comparison)
    parsed = json.loads(ref.stdout)
    assert parsed["hookSpecificOutput"]["permissionDecision"] == "deny"


# ── T3 — flag ON, in-scope apply_patch: two correlated outcomes + primary fidelity
# Acceptance: "run CC hooks and middleware for the same protected event";
# "records both enforcement outcomes with a shared correlation identifier."

def test_flag_on_in_scope_apply_patch_emits_two_correlated_outcomes(harness):
    # @oracle: LIA-413 AC — both cc-hook + middleware outcomes, one shared CID, one shim call
    event = _apply_patch_event(harness.root)          # no marker -> both deny
    flat = _bucket_dir(harness.root, harness.root)

    # Baseline (flag off) primary bytes, to prove flag-on primary fidelity.
    off = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                    flag_on=False, project_dir=harness.root, cwd=harness.root)

    on = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                   flag_on=True, project_dir=harness.root, cwd=harness.root)
    # Primary is the ONLY output that reaches Claude — it must be byte-identical.
    assert on.stdout == off.stdout, "flag-on primary stdout must equal the flag-off baseline (deny)"
    assert on.returncode == off.returncode, "flag-on primary exit must equal the flag-off baseline"

    recs = _wait_for(lambda: _outcomes(flat) if len(_outcomes(flat)) >= 2 else None)
    recs = _outcomes(flat)
    assert len(recs) == 2, f"expected exactly two outcome records, got {len(recs)}: {recs}"

    invs = {r.get("invocation") for r in recs}
    assert invs == {"cc-hook", "middleware"}, f"outcomes must tag both invocations, got {invs}"

    cids = {r.get("correlation_id") for r in recs}
    assert len(cids) == 1, f"both outcomes must share ONE correlation id, got {cids}"
    cid = cids.pop()
    assert isinstance(cid, str) and cid, "correlation id must be a non-empty string minted by the shim"

    for r in recs:
        assert r.get("decision") == "deny", f"both invocations decided deny here: {r}"
        assert r.get("behavior") == "plan-review-gate", f"behavior tag must name the gate: {r}"

    # The cc-hook deny reason must be the exact live permissionDecisionReason.
    live_reason = json.loads(off.stdout)["hookSpecificOutput"]["permissionDecisionReason"]
    cc = next(r for r in recs if r["invocation"] == "cc-hook")
    assert cc.get("reason") == live_reason, "cc-hook outcome reason must equal the live deny feedback"


# ── T4 — the OTHER shared-trigger shape (commit-shaped Bash) is also in scope ──

def test_flag_on_in_scope_commit_bash_emits_two_correlated_outcomes(harness):
    # @oracle: LIA-413 — commit-shaped Bash (GIT_COMMIT_RE) is in the shared trigger contract
    event = _commit_bash_event(harness.root)          # no .verified -> deny
    flat = _bucket_dir(harness.root, harness.root)

    _run_shim(harness.shim, "verification-gate", event, env_base=harness.env_base,
              flag_on=True, project_dir=harness.root, cwd=harness.root)

    _wait_for(lambda: _outcomes(flat) if len(_outcomes(flat)) >= 2 else None)
    recs = _outcomes(flat)
    assert len(recs) == 2, f"commit-shaped Bash must be shadow-enforced, got {len(recs)} records"
    assert {r.get("invocation") for r in recs} == {"cc-hook", "middleware"}
    cids = {r.get("correlation_id") for r in recs}
    assert len(cids) == 1 and all(cids), f"one shared, non-empty correlation id required, got {cids}"


# ── T5 — scope discrimination: out-of-scope events produce NO telemetry ────────
# Acceptance: an event outside the shared contract runs ONLY the primary — no
# shadow invocation, no telemetry. Proven positively (in-scope emits) so the
# assertion is red pre-implementation, and negatively (out-of-scope is silent).

def test_flag_on_out_of_scope_write_produces_no_shadow_telemetry(harness):
    # @oracle: LIA-413 — Write is OUTSIDE the trigger contract: no shadow, no telemetry
    flat = _bucket_dir(harness.root, harness.root)

    # Out-of-scope event first: must add nothing.
    _run_shim(harness.shim, "plan-review-gate", _write_event(harness.root),
              env_base=harness.env_base, flag_on=True,
              project_dir=harness.root, cwd=harness.root)
    # In-scope event second: must add exactly the two records.
    _run_shim(harness.shim, "plan-review-gate", _apply_patch_event(harness.root),
              env_base=harness.env_base, flag_on=True,
              project_dir=harness.root, cwd=harness.root)

    _wait_for(lambda: _outcomes(flat) if len(_outcomes(flat)) >= 2 else None)
    recs = _outcomes(flat)
    assert len(recs) == 2, (
        "only the in-scope apply_patch may emit telemetry; the Write must be "
        f"silent — expected 2 records total, got {len(recs)}: {recs}"
    )


# ── T6 — telemetry bucket derives from event['cwd'], NOT --workspace-root ─────
# The secondary carries --workspace-root=WORKTREE_ROOT, yet BOTH records must
# land in the bucket for event['cwd']. Here event cwd = a linked worktree B while
# WORKTREE_ROOT (from CLAUDE_PROJECT_DIR) = the main repo (flat). Records must be
# in B's bucket and NOT in the flat bucket.

def test_telemetry_bucket_follows_event_cwd_not_workspace_root(harness, tmp_path):
    # @oracle: LIA-413 telemetry schema — bucket from event['cwd'], never from --workspace-root
    wt_b = (tmp_path / "wt_b").resolve()
    _git(harness.root, "worktree", "add", "-q", "--detach", str(wt_b), "HEAD")

    event = _apply_patch_event(wt_b)          # event cwd = worktree B
    bucket_b = _bucket_dir(harness.root, wt_b)
    flat = _bucket_dir(harness.root, harness.root)

    # CLAUDE_PROJECT_DIR = main repo -> secondary --workspace-root = main (flat).
    _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
              flag_on=True, project_dir=harness.root, cwd=harness.root)

    _wait_for(lambda: _outcomes(bucket_b) if len(_outcomes(bucket_b)) >= 2 else None)
    recs_b = _outcomes(bucket_b)
    assert len(recs_b) == 2, (
        "both outcomes must be bucketed by event['cwd'] (worktree B), got "
        f"{len(recs_b)} in {bucket_b}"
    )
    assert {r.get("invocation") for r in recs_b} == {"cc-hook", "middleware"}
    assert _outcomes(flat) == [], (
        "no outcome may be written to the --workspace-root (flat) bucket; the "
        "bucket must ignore --workspace-root entirely"
    )


# ── T7 — decision disagreement emits an explicit divergence signal ────────────
# Acceptance: "Outcome or feedback disagreement emits an explicit divergence
# signal." Constructed as a real black-box scenario: the marker exists only in
# the flat bucket. The primary (cc-hook, event cwd = flat) resolves ALLOW; the
# secondary (middleware, --workspace-root = worktree B, no marker) resolves DENY.

def test_flag_on_decision_divergence_emits_signal(harness, tmp_path):
    # @oracle: LIA-413 AC — decision disagreement produces a divergence record
    wt_b = (tmp_path / "wt_b").resolve()
    _git(harness.root, "worktree", "add", "-q", "--detach", str(wt_b), "HEAD")
    (harness.root / ".claude" / ".plan-reviewed").touch()   # marker in FLAT bucket only

    event = _apply_patch_event(harness.root)     # event cwd = flat -> primary ALLOW
    flat = _bucket_dir(harness.root, harness.root)

    # CLAUDE_PROJECT_DIR = worktree B -> secondary --workspace-root = B (no marker -> DENY).
    on = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                   flag_on=True, project_dir=wt_b, cwd=harness.root)
    # Primary authority: the live decision reaching Claude is ALLOW (empty stdout).
    assert on.stdout == "", "the primary (cc-hook) is authoritative and here decides allow"

    _wait_for(lambda: _divergences(flat) if _divergences(flat) else None)
    divs = _divergences(flat)
    assert len(divs) >= 1, "a decision disagreement must emit a divergence record"
    d = divs[0]
    assert d.get("signal") == "warden_double_enforcement_divergence", f"wrong signal: {d}"
    assert "decision" in (d.get("mismatches") or []), f"'decision' mismatch expected, got {d}"

    # The two outcomes disagree and are correlated to the same CID as the divergence.
    outs = _outcomes(flat)
    by_inv = {r["invocation"]: r for r in outs}
    assert by_inv.get("cc-hook", {}).get("decision") == "allow"
    assert by_inv.get("middleware", {}).get("decision") == "deny"
    cids = {r["correlation_id"] for r in outs} | {d.get("correlation_id")}
    assert len(cids) == 1, f"divergence + both outcomes must share one CID, got {cids}"


# ── T8 — agreement case: two matching outcomes, NO divergence ─────────────────
# Acceptance: "Agreement and divergence cases are covered by tests." Marker
# present in the (single) worktree -> both invocations ALLOW -> no divergence.

def test_flag_on_agreement_two_allow_outcomes_no_divergence(harness):
    # @oracle: LIA-413 AC — agreement (both allow) records two outcomes and NO divergence
    (harness.root / ".claude" / ".plan-reviewed").touch()   # -> both allow
    event = _apply_patch_event(harness.root)
    flat = _bucket_dir(harness.root, harness.root)

    on = _run_shim(harness.shim, "plan-review-gate", event, env_base=harness.env_base,
                   flag_on=True, project_dir=harness.root, cwd=harness.root)
    assert on.stdout == "", "allow reaches Claude as zero bytes (primary fidelity, allow)"

    _wait_for(lambda: _outcomes(flat) if len(_outcomes(flat)) >= 2 else None)
    recs = _outcomes(flat)
    assert len(recs) == 2, f"agreement still records BOTH outcomes, got {len(recs)}"
    assert {r.get("invocation") for r in recs} == {"cc-hook", "middleware"}
    assert all(r.get("decision") == "allow" for r in recs), f"both must be allow: {recs}"
    assert all(r.get("reason") in (None, "") for r in recs), f"allow reason must be null: {recs}"

    # No divergence must be emitted when the two enforcement outcomes agree.
    assert _divergences(flat) == [], f"agreement must emit no divergence record: {_divergences(flat)}"
