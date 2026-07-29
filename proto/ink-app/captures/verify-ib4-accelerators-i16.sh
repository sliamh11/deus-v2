#!/usr/bin/env bash
# LIA-496 IB4 (I14 accelerators + I16 verification) — capture 2 of 3.
#
# Covers two things in one recording:
#   1. The y/n single-key accelerators (unchanged fast path — I14's header
#      comment on why arrow+enter is an ADDITION, not a replacement).
#   2. I16's actual verification: with a `delete_file` prompt genuinely
#      pending, ctrl+t and ctrl+n must both be no-ops (no picker opens, no
#      thread switch, the prompt stays pending and unresolved) — NOT
#      asserted from I3+I14's structural changes alone. This capture is the
#      redone-correctly proof: an EARLIER manual repro (before this
#      recording, not included in it) caught ctrl+n falling through to
#      `PermissionPrompt.tsx`'s own bare `input === "n"` accelerator check
#      and silently denying the prompt — a real bug, now fixed (see that
#      file's own header comment on the fix) and re-verified live here.
#
# Real tmux pane + real `tmux send-keys -l`/named-key keystrokes under
# `asciinema rec` — no scripted prop injection. `env USER=you LOGNAME=you`
# for a clean, non-personal capture (see capture 1's script for the
# mechanism this depends on).
set -euo pipefail

SESSION="lia496-ib4-accelerators-i16"
COLS=130
ROWS=50
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/ib4-proof2-accelerators-i16-guard.cast"
GIF_FILE="${OUT_DIR}/ib4-proof2-accelerators-i16-guard.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'env USER=you LOGNAME=you npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# --- Navigate to "Status-glyph rendering fix". ---
tmux send-keys -t "${SESSION}" C-t
sleep 1
tmux send-keys -t "${SESSION}" Enter
sleep 1

# --- Turn 1: trigger the delete_file prompt. ---
tmux send-keys -t "${SESSION}" -l "hello there"
tmux send-keys -t "${SESSION}" Enter
sleep 9
# Frame: prompt visible, default highlighted.
sleep 1

# --- I16 verification: ctrl+t then ctrl+n while genuinely pending. Both
#     must be complete no-ops — the prompt must NOT resolve, no picker must
#     open. Held a moment each so the (lack of) change is visible on
#     replay, not just instantaneous. ---
tmux send-keys -t "${SESSION}" C-t
sleep 1.5
tmux send-keys -t "${SESSION}" C-n
sleep 1.5

# --- Resolve via the "n" accelerator (deny) — the exact keystroke the I16
#     bug this capture re-verifies was being falsely triggered by by
#     ctrl+n above; pressing it for real here proves the bare "n" path
#     still works correctly on its own once the ctrl-guard is in place. ---
tmux send-keys -t "${SESSION}" -l "n"
sleep 5

# --- Turn 2: plain follow-up. ---
tmux send-keys -t "${SESSION}" -l "did that leave anything else stale in /tmp?"
tmux send-keys -t "${SESSION}" Enter
sleep 8

# --- Turn 3: second delete_file prompt (turn 1 was denied, not
#     always-allowed, so this is a genuine new pending decision). ---
tmux send-keys -t "${SESSION}" -l "one more check, anything else stale?"
tmux send-keys -t "${SESSION}" Enter
sleep 9
sleep 1

# --- Resolve via the "y" accelerator (allow once). ---
tmux send-keys -t "${SESSION}" -l "y"
sleep 6

# Stop the recording (no approval pending, so ctrl+c genuinely exits).
tmux send-keys -t "${SESSION}" C-c
sleep 1
tmux send-keys -t "${SESSION}" -l "exit"
tmux send-keys -t "${SESSION}" Enter
sleep 1
tmux kill-session -t "${SESSION}" 2>/dev/null || true

agg "${CAST_FILE}" "${GIF_FILE}"

python3 - "${GIF_FILE}" "${OUT_DIR}" <<'PY'
import sys
from PIL import Image

gif_path, out_dir = sys.argv[1], sys.argv[2]
im = Image.open(gif_path)
print(f"n_frames={im.n_frames}")
for i in range(im.n_frames):
    im.seek(i)
    im.convert("RGB").save(f"{out_dir}/_scratch-ib4p2-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-ib4p2-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
