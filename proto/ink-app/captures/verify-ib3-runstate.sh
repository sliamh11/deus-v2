#!/usr/bin/env bash
# LIA-496 IB3 — I11 capture: the composed StatusLine run-state row
# (spinner + elapsed, via LoadingPrimitive) and the genuinely-custom
# esc-cancel wiring (`useComposerCancel`). Real tmux pane + real
# `tmux send-keys` keystrokes under `asciinema rec`, same mechanism as
# every other Ink capture in this build — no scripted prop injection.
#
# Scenario, timed against this fixture's own real durations (measured live
# before writing this script, not guessed): "LIA-495 migration spike"'s
# SECOND turn streams for ~7.4s uninterrupted — long enough to reliably
# esc partway through and still have a genuinely-long remainder that would
# have kept streaming had cancel not fired.
set -euo pipefail

SESSION="lia496-ib3-runstate-verify"
COLS=120
ROWS=40
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/ib3-proof1-runstate-esc-cancel.cast"
GIF_FILE="${OUT_DIR}/ib3-proof1-runstate-esc-cancel.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "USER=you LOGNAME=you asciinema rec -c 'npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# 1. Open the thread list, navigate to "LIA-495 migration spike" (index 3:
#    Status-glyph rendering fix, Composer keyboard shortcuts, Shiki theme
#    swap crash, LIA-495 migration spike), select it.
tmux send-keys -t "${SESSION}" C-t
sleep 1
tmux send-keys -t "${SESSION}" Down
sleep 0.3
tmux send-keys -t "${SESSION}" Down
sleep 0.3
tmux send-keys -t "${SESSION}" Down
sleep 0.3
tmux send-keys -t "${SESSION}" Enter
sleep 1

# 2. First send: turn 1 (short) — establishes real prior content in
#    scrollback before the interrupt test, and shows the spinner/elapsed
#    row settling to idle naturally (contrast case).
tmux send-keys -t "${SESSION}" -l "why did LIA-495 need zero logic changes on web?"
tmux send-keys -t "${SESSION}" Enter
sleep 8

# 3. Second send: turn 2, the long one. Let the spinner+elapsed run
#    visibly for ~2s (long enough to see the elapsed counter genuinely
#    tick and the composed LoadingPrimitive/StatusBarPrimitive row render)
#    before interrupting.
tmux send-keys -t "${SESSION}" -l "second question — keep streaming for a while please"
tmux send-keys -t "${SESSION}" Enter
sleep 2

# 4. esc — must genuinely halt: no further tokens append afterward.
tmux send-keys -t "${SESSION}" Escape
sleep 1

# 5. Hold the settled, post-cancel frame on screen for a few more seconds
#    so the recording itself shows the text NOT continuing (the actual
#    claim under test), not just the moment of the keypress.
sleep 4

# 6. Stop the recording.
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
    im.convert("RGB").save(f"{out_dir}/_scratch-ib3-runstate-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-ib3-runstate-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
