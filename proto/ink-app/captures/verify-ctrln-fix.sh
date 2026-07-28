#!/usr/bin/env bash
# LIA-496 — code-review REVISE round re-capture for the `ctrl+n` message-pane
# rebind fix (App.tsx `MainPane`/`useThreadRuntime` + freshDraftTracker.ts +
# Sidebar.tsx). Replaces the two FAIL stills
# (ctrln-thread-pane-not-cleared-bug.png,
# thread-switch-messages-bleed-bug.png) referenced in VERIFICATION.md's Ink
# "New-session empty state (ctrl+n)" row.
#
# Real tmux pane + real `tmux send-keys -l` keystrokes under `asciinema rec`,
# same mechanism as the original S3 captures — no scripted prop injection.
set -euo pipefail

SESSION="lia496-ctrln-fix-verify"
COLS=130
ROWS=60
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/verify-ctrln-fix.cast"
GIF_FILE="${OUT_DIR}/verify-ctrln-fix.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# 1. Switch to a seeded thread with real content (Status-glyph rendering fix).
tmux send-keys -t "${SESSION}" Tab
sleep 1
tmux send-keys -t "${SESSION}" Enter
sleep 2
tmux send-keys -t "${SESSION}" Tab
sleep 1
tmux send-keys -t "${SESSION}" -l "hello there"
tmux send-keys -t "${SESSION}" Enter
sleep 8
tmux send-keys -t "${SESSION}" -l "y"
sleep 8

# 2. First ctrl+n: pane must clear to EmptyState (this was already the
#    working half even pre-fix; kept for continuity of the recording).
tmux send-keys -t "${SESSION}" C-n
sleep 2

# 3. Submit a message into this first draft — must land isolated, not
#    appended into the stale prior thread (the literal FAIL text: "the new
#    user turn ... gets rendered appended into the SAME stale pane").
tmux send-keys -t "${SESSION}" -l "draft one message"
tmux send-keys -t "${SESSION}" Enter
sleep 5

# 4. Switch to a DIFFERENT, never-yet-run seeded thread (Composer keyboard
#    shortcuts) — the "subsequent sidebar-row switch attempt" the FAIL text
#    named. Must show EmptyState, not draft one's content.
tmux send-keys -t "${SESSION}" Tab
sleep 1
tmux send-keys -t "${SESSION}" Down
sleep 0.5
tmux send-keys -t "${SESSION}" Down
sleep 0.5
tmux send-keys -t "${SESSION}" Enter
sleep 2

# 5. Stop the recording.
tmux send-keys -t "${SESSION}" C-c
sleep 1
tmux send-keys -t "${SESSION}" -l "exit"
tmux send-keys -t "${SESSION}" Enter
sleep 1
tmux kill-session -t "${SESSION}" 2>/dev/null || true

agg "${CAST_FILE}" "${GIF_FILE}"

# Dump every frame with an index-numbered filename first — the exact
# meaningful indices are picked by hand afterward (visual inspection),
# same as the original S3 capture's own documented approach, not guessed
# from fixed offsets.
python3 - "${GIF_FILE}" "${OUT_DIR}" <<'PY'
import sys
from PIL import Image

gif_path, out_dir = sys.argv[1], sys.argv[2]
im = Image.open(gif_path)
print(f"n_frames={im.n_frames}")
for i in range(im.n_frames):
    im.seek(i)
    im.convert("RGB").save(f"{out_dir}/_scratch-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
