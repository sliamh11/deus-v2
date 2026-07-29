#!/usr/bin/env bash
# LIA-496 IB3 — I12 capture: `HelpOverlay.tsx`, dedicated (per round-3
# plan-review, the same gap that made `ThreadPicker.tsx` need its own
# call-site capture in round 2 — a brand-new rendering surface is not
# considered proven by another batch's proof). Shows: `?` opening the
# overlay from an empty composer, its real content rendering, `?` again
# dismissing it, `/help` opening it a second way, and `esc` dismissing it.
# Real tmux pane + real `tmux send-keys` keystrokes under `asciinema rec` —
# no scripted prop injection.
set -euo pipefail

SESSION="lia496-ib3-help-verify"
COLS=120
ROWS=40
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/ib3-proof2-help-overlay.cast"
GIF_FILE="${OUT_DIR}/ib3-proof2-help-overlay.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "USER=you LOGNAME=you asciinema rec -c 'npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# 1. `?` from the empty composer — opens the overlay.
tmux send-keys -t "${SESSION}" -l "?"
sleep 2

# 2. `?` again — closes it (the toggle's own close half).
tmux send-keys -t "${SESSION}" -l "?"
sleep 2

# 3. `/help` — the Enter-submitted alternate path to the same overlay.
tmux send-keys -t "${SESSION}" -l "/help"
sleep 0.5
tmux send-keys -t "${SESSION}" Enter
sleep 2

# 4. `esc` — closes it (the OTHER dismissal path).
tmux send-keys -t "${SESSION}" Escape
sleep 2

# 5. Confirm the composer is genuinely empty afterward (no stray "?"/
#    "/help" text left behind by either toggle path).
sleep 1

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
    im.convert("RGB").save(f"{out_dir}/_scratch-ib3-help-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-ib3-help-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
