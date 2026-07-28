#!/usr/bin/env bash
# LIA-496 — code-review REVISE round 2 re-capture. Covers two findings in
# one recording, real tmux pane + real `tmux send-keys -l` keystrokes under
# `asciinema rec`, same mechanism as every prior S3 capture (no scripted
# prop injection):
#
#   1. Sidebar.tsx line-merge + Today/Yesterday header-mislabeling fix
#      (`ThreadListPrimitive.Root flexDirection="column"` + `threadIds`-based
#      ordering instead of `Object.keys(threadItems)`).
#   2. TokenLine.tsx / codeClipboard.ts / CodeCopyHotkey.tsx — the OSC-52
#      best-effort code-block copy feature, previously entirely unimplemented.
#
# Also incidentally re-confirms the ctrl+n fix (App.tsx/freshDraftTracker.ts)
# still works with the new ctrl+y global hotkey mounted alongside it.
set -euo pipefail

SESSION="lia496-revise-round2-verify"
COLS=130
ROWS=60
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/verify-revise-round2.cast"
GIF_FILE="${OUT_DIR}/verify-revise-round2.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 5
# Frame A: fresh idle boot — the "+ new se── today" line-merge repro point
# (finding 3). Hold here a moment so agg definitely emits a frame.
sleep 2

# --- OSC-52 copy proof: navigate (clean 7-item list, index 6 = last =
#     streaming-markdown-flicker) then send a message that produces a real
#     fenced ```typescript block, let it render, then ctrl+y. ---
tmux send-keys -t "${SESSION}" Tab
sleep 0.5
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Down
sleep 0.2
tmux send-keys -t "${SESSION}" Enter
sleep 1
tmux send-keys -t "${SESSION}" Tab
sleep 0.5
tmux send-keys -t "${SESSION}" -l "What's causing the flicker?"
tmux send-keys -t "${SESSION}" Enter
# Full turn (narration + Bash tool call + closing prose + fenced code
# block) takes longer than the first draft of this script assumed (a 6s
# wait landed mid-stream, before TokenLine had mounted at all, so ctrl+y
# silently no-op'd — confirmed live via an ad hoc tmux repro before fixing
# this script). 14s reliably clears the whole turn.
sleep 14
tmux send-keys -t "${SESSION}" C-y
sleep 1
# Frame B: the "copied (ctrl+y)" indicator frame.
sleep 2

# --- header-mislabeling repro: ctrl+n (still with a real, already-run
#     thread's content on screen), submit a draft — the exact sequence
#     that used to desync threadIds vs the old Object.keys(threadItems)
#     snapshot. ---
tmux send-keys -t "${SESSION}" C-n
sleep 1
tmux send-keys -t "${SESSION}" -l "draft one message"
tmux send-keys -t "${SESSION}" Enter
sleep 3
# Frame C: post-interaction sidebar state for the header-order check
# (Shiki theme swap crash / hoursAgo(2) must still read "today"; Streaming
# markdown flicker / hoursAgo(33) must still read "yesterday") — and also
# confirms ctrl+n's pane-clear/isolated-submit fix still holds.
sleep 2

# Stop the recording.
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
    im.convert("RGB").save(f"{out_dir}/_scratch-r2-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-r2-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
