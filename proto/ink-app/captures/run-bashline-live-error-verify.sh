#!/usr/bin/env bash
# LIA-496 IB2 round-2 — throwaway tmux-driven runner for
# verify-bashline-live-error.tsx (code-review REVISE fix verification, NOT
# a numbered-requirement capture: no gif/cast/png is produced, this only
# proves the mount-time-only useState(isError) bug is fixed). Real tmux
# pty needed because BashLine's ctrl+o `useInput` requires raw-mode
# support, which bare `npx tsx` outside a tty doesn't have.
#
# Run from ink-app/:  bash captures/run-bashline-live-error-verify.sh
set -euo pipefail

SESSION="lia496-ib2-bashline-verify"
OUT_FILE="/tmp/lia496-ib2-bashline-verify.txt"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x 100 -y 20
tmux send-keys -t "${SESSION}" -l "npx tsx captures/verify-bashline-live-error.tsx"
tmux send-keys -t "${SESSION}" Enter
sleep 2.5
tmux capture-pane -t "${SESSION}" -p > "${OUT_FILE}"
sleep 0.5
tmux kill-session -t "${SESSION}" 2>/dev/null || true

echo "--- captured pane ---"
cat "${OUT_FILE}"
echo "--- assertions ---"
if grep -q "ctrl+o expand" "${OUT_FILE}"; then
  echo "FAIL: cap indicator still present — did not auto-expand on the live instance"
  exit 1
fi
if ! grep -q "stack frame 8: boom" "${OUT_FILE}"; then
  echo "FAIL: full error tail (line 8) not visible"
  exit 1
fi
echo "PASS: live-mounted BashLine auto-expanded when isError transitioned to true"
