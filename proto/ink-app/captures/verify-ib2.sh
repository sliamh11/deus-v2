#!/usr/bin/env bash
# LIA-496 IB2 — real tmux+asciinema capture for the "Content grammar" batch
# (I6 capped Bash output + ctrl+o expand, I7 unified tool glyph, I8 dropped
# speaker labels, I9 unboxed thinking/code/diff chrome, I10 diff panel
# box/gutter/silent-cap fix). Same mechanism as
# captures/verify-ctrln-fix.sh/verify-flow.sh — a real tmux pane running the
# app under `asciinema rec`, driven with genuine `tmux send-keys -l`
# keystrokes, converted to gif via `agg`, stills pulled via PIL.
#
# `env USER=you LOGNAME=you` — public-repo-safe capture: identity.ts's
# `getUserLabel()` (LIA-496 IB1, I5) checks `$USER`/`$LOGNAME` BEFORE
# `os.userInfo().username` specifically so a clean, non-personal capture is
# possible without touching that function's fail-closed contract (see that
# file's own header comment).
#
# Run from ink-app/:  bash captures/verify-ib2.sh
set -euo pipefail

SESSION="lia496-ib2-verify"
COLS=130
ROWS=45
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/verify-ib2.cast"
GIF_FILE="${OUT_DIR}/verify-ib2.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'env USER=you LOGNAME=you npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# 1. Open the thread picker, navigate to "LIA-495 migration spike" (index 3:
#    status-glyph-fix, composer-shortcuts, theme-swap-crash, then this one).
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

# 2. Trigger the scripted turn — its Bash tool call's result is the
#    sanctioned 6-line fixture lengthening (I6's demo content).
tmux send-keys -t "${SESSION}" -l "recap the import"
tmux send-keys -t "${SESSION}" Enter

# 3. Poll for the capped indicator while the message is STILL live (closing
#    text not yet finished) — committedBlocks.tsx now holds a capped part
#    live until its message settles specifically so this window is
#    realistic, not a single React tick. Press ctrl+o the moment it's safe.
for i in $(seq 1 20); do
  sleep 0.15
  out=$(tmux capture-pane -t "${SESSION}" -p)
  if echo "${out}" | grep -q "ctrl+o expand" && ! echo "${out}" | grep -q "differ by import specifier"; then
    tmux send-keys -t "${SESSION}" C-o
    sleep 1
    break
  fi
done

# 4. Toggle back to collapsed, so the recording shows both directions.
tmux send-keys -t "${SESSION}" C-o
sleep 1.5

# 5. Switch to "Sidebar layout pass" (an Edit-tool thread) to demonstrate
#    the unboxed, single-gutter diff panel (I9/I10) with the same unified
#    tool glyph (I7). Cursor re-opens on the CURRENT main thread (now "LIA-
#    495 migration spike", index 3 of 7) — exactly one Down reaches
#    "Sidebar layout pass" (index 4).
tmux send-keys -t "${SESSION}" C-t
sleep 1
tmux send-keys -t "${SESSION}" Down
sleep 0.3
tmux send-keys -t "${SESSION}" Enter
sleep 1
tmux send-keys -t "${SESSION}" -l "show me the diff"
tmux send-keys -t "${SESSION}" Enter
sleep 7

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
    im.convert("RGB").save(f"{out_dir}/_ib2-scratch-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _ib2-scratch-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
