#!/bin/bash
# Thin shim for Claude Code hooks → scripts/codex_warden_hooks.py.
# macOS/Linux only; Windows users: use `codex_warden_hooks.py install`.
#
# When Claude Code runs inside a git worktree, CLAUDE_PROJECT_DIR points to
# the worktree path, not the main repo root. Hooks and wardens need the main
# repo root to find .claude/wardens/, markers, and shared config. We derive
# two distinct paths:
#
#   WORKTREE_ROOT — where the code being edited lives (git show-toplevel)
#   REPO_ROOT     — where shared .claude/ config lives (git-common-dir parent)
#
# For regular (non-worktree) repos, both paths are identical. The script is
# always loaded from REPO_ROOT so the stable main-branch version is used.
set -e

# Resolve worktree root from CLAUDE_PROJECT_DIR (the dir Claude was launched in).
WORKTREE_ROOT=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null \
  || echo "${CLAUDE_PROJECT_DIR:-.}")

# Derive main repo root from the shared .git dir (handles worktrees correctly).
# --path-format=absolute ensures we get a full path even from the main repo
# where --git-common-dir returns the relative string ".git".
REPO_ROOT=$(git -C "$WORKTREE_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
  | sed 's|/\.git$||')

# Fall back to WORKTREE_ROOT if the git command failed (non-git dirs, etc.).
REPO_ROOT="${REPO_ROOT:-$WORKTREE_ROOT}"

if [ "${DEUS_WARDEN_DOUBLE_ENFORCEMENT:-}" != "1" ]; then # LIA-413
exec python3 "$REPO_ROOT/scripts/codex_warden_hooks.py" run "$@" \
  --repo-root "$REPO_ROOT"
fi

EVENT_JSON=$(cat)

# Ask the Python runner to apply the exact shared trigger contract (including
# its existing GIT_COMMIT_RE); do not duplicate that policy in shell.
if ! printf '%s' "$EVENT_JSON" | python3 "$REPO_ROOT/scripts/codex_warden_hooks.py" \
  double-enforcement-applicable "$@"; then
  printf '%s' "$EVENT_JSON" | python3 "$REPO_ROOT/scripts/codex_warden_hooks.py" \
    run "$@" --repo-root "$REPO_ROOT"
  exit $?
fi

CID=$(python3 -c 'import uuid; print(uuid.uuid4())')
PRIMARY_RC=
PRIMARY_OUT=$(printf '%s' "$EVENT_JSON" | \
  python3 "$REPO_ROOT/scripts/codex_warden_hooks.py" run "$@" \
    --correlation-id "$CID" --invocation cc-hook --repo-root "$REPO_ROOT") \
  || PRIMARY_RC=$?
PRIMARY_RC="${PRIMARY_RC:-0}"

# The launcher creates a new process session and converts spawn failures into
# telemetry. Its status is observational and never changes the primary result.
printf '%s' "$EVENT_JSON" | \
  python3 "$REPO_ROOT/scripts/codex_warden_hooks.py" launch-double-enforcement "$@" \
    --correlation-id "$CID" --repo-root "$REPO_ROOT" \
    --workspace-root "$WORKTREE_ROOT" >/dev/null 2>&1 || :

if [ -n "$PRIMARY_OUT" ]; then
  printf '%s\n' "$PRIMARY_OUT"
fi
exit "$PRIMARY_RC"
