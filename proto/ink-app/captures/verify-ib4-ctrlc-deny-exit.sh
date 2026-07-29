#!/usr/bin/env bash
# LIA-496 IB4 (I14, D1) — capture 3 of 3: ctrl+c as deny, and the
# ctrl+c-exits-the-app fallback once no approval is pending.
#
# The mechanism this proves, stated up front (full trace in main.tsx's own
# header comment): Ink's default `exitOnCtrlC: true` filters ctrl+c out of
# EVERY `useInput` consumer before it ever reaches a component callback
# (`ink/build/hooks/use-input.js`'s own `handleData`), so `main.tsx` sets
# `exitOnCtrlC: false` and `App.tsx`'s `useThreadNavigation` now owns a
# manual `useApp().exit()` call for the "no approval pending" case. This
# capture is the live proof that flipping that flag didn't silently break
# the ordinary "ctrl+c quits the app" expectation for every OTHER moment —
# only the exact window `PermissionPrompt.tsx` needs it changes.
#
# Real tmux pane + real `tmux send-keys`/named-key keystrokes under
# `asciinema rec` — no scripted prop injection. `env USER=you LOGNAME=you`
# for a clean, non-personal capture (see capture 1's script for why).
set -euo pipefail

SESSION="lia496-ib4-ctrlc-deny-exit"
COLS=130
ROWS=50
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/ib4-proof3-ctrlc-deny-then-exit.cast"
GIF_FILE="${OUT_DIR}/ib4-proof3-ctrlc-deny-then-exit.gif"

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
sleep 1

# --- ctrl+c while pending = deny. Must NOT exit the app. ---
tmux send-keys -t "${SESSION}" C-c
sleep 5
# Frame: "delete_file(...) — Deny" resolved line, turn continued and
# completed on its own (the same auto-continuation any other deny path
# triggers) — the app is still very much running.

# --- No approval pending now. ctrl+c here must genuinely exit the app —
#     this is the fallback `useThreadNavigation` owns once `exitOnCtrlC` is
#     globally off. This ALSO stops the recording (the wrapped command
#     exiting ends `asciinema rec -c '...'`), so no separate `exit` step is
#     needed the way the other two capture scripts have one. ---
sleep 2
tmux send-keys -t "${SESSION}" C-c
sleep 2
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
    im.convert("RGB").save(f"{out_dir}/_scratch-ib4p3-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-ib4p3-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
