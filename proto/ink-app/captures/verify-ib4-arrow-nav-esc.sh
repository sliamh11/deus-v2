#!/usr/bin/env bash
# LIA-496 IB4 (I14, D1) — capture 1 of 3: the arrow-navigation + visible-
# default + Enter-confirm path, and the esc-deny path, both on real live
# `delete_file` approvals (thread "Status-glyph rendering fix", turn 1 then
# turn 3 — see shared/src/fixtures/conversations.ts's own header comment
# for why turn 3 only prompts again when turn 1 wasn't resolved
# "allow_always"; this script resolves turn 1 via "allow once" instead, so
# turn 3 genuinely re-prompts rather than auto-granting).
#
# Real tmux pane + real `tmux send-keys -l`/named-key keystrokes under
# `asciinema rec`, same mechanism as every prior S3/IB1 capture — no
# scripted prop injection.
set -euo pipefail

SESSION="lia496-ib4-arrow-nav-esc"
COLS=130
ROWS=50
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/ib4-proof1-arrow-nav-esc-deny.cast"
GIF_FILE="${OUT_DIR}/ib4-proof1-arrow-nav-esc-deny.gif"

mkdir -p "${OUT_DIR}"

tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

# `env USER=you LOGNAME=you` — required for a clean, non-personal capture:
# `identity.ts`'s `getUserLabel()` reads `$USER`/`$LOGNAME` FIRST (see that
# file's own header comment on the REVISE-round username-leak fix), falling
# through to the real OS account name otherwise. Confirmed live before
# writing this script: the bare invocation prints the real local account
# name into the once-printed identity banner (`model: sonnet-5 ·
# <real-username> · ink-app`) — exactly the class of personal-value leak
# this batch's own mechanical sweep instruction exists to prevent, just at
# capture time instead of in source.
tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'env USER=you LOGNAME=you npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3

# --- Navigate to "Status-glyph rendering fix" (index 0, first seeded
#     thread — the app boots on a brand-new empty draft thread, per
#     `EmptyState`'s "No messages in this session yet", not any seeded
#     thread, so ctrl+t is required). `ThreadPicker`'s cursor already
#     defaults to index 0 (`useState(() => Math.max(0,
#     items.findIndex(...)))` finds no match for a brand-new thread id, so
#     `Math.max(0, -1) === 0`), and its own `useInput` bypasses Ink's
#     `useFocus` system entirely (same as `PermissionPrompt.tsx`), so
#     closing it via Enter hands focus back to `ComposerPrimitive.Input`'s
#     `autoFocus` claim on its own remount — confirmed live before writing
#     this script: no extra Tab is needed, typed text lands in the
#     composer immediately after picker-close. ---
tmux send-keys -t "${SESSION}" C-t
sleep 1
tmux send-keys -t "${SESSION}" Enter
sleep 1

# --- Turn 1: trigger the delete_file prompt. ---
tmux send-keys -t "${SESSION}" -l "hello there"
tmux send-keys -t "${SESSION}" Enter
sleep 9
# Frame: prompt visible, default ("allow once", index 0) highlighted.
sleep 1

# --- Arrow-nav walk: right, right (now on "deny"), then left, left back to
#     default — proves the caret genuinely moves through all three options
#     and wraps, not just a static render. ---
tmux send-keys -t "${SESSION}" Right
sleep 1
tmux send-keys -t "${SESSION}" Right
sleep 1
tmux send-keys -t "${SESSION}" Left
sleep 1
tmux send-keys -t "${SESSION}" Left
sleep 1
# Now back on index 0 ("allow once", the default) — confirm via Enter, not
# a y/a/n shortcut, proving Enter resolves whatever is CURRENTLY
# highlighted (state), not a hardcoded key.
tmux send-keys -t "${SESSION}" Enter
sleep 6

# --- Turn 2: plain follow-up, no approval involved. ---
tmux send-keys -t "${SESSION}" -l "did that leave anything else stale in /tmp?"
tmux send-keys -t "${SESSION}" Enter
sleep 8

# --- Turn 3: SECOND delete_file prompt (turn 1 was "allow once", not
#     "always allow", so this is a genuine new pending decision, not the
#     grant-store auto-approval case). ---
tmux send-keys -t "${SESSION}" -l "one more check, anything else stale?"
tmux send-keys -t "${SESSION}" Enter
sleep 9
# Frame: second prompt visible.
sleep 1

# --- esc = deny. ---
tmux send-keys -t "${SESSION}" Escape
sleep 6

# Stop the recording (no approval pending now, so ctrl+c genuinely exits —
# see main.tsx / App.tsx's useThreadNavigation header comments).
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
    im.convert("RGB").save(f"{out_dir}/_scratch-ib4p1-frame-{i:03d}.png")
PY

echo "Done — ${CAST_FILE} / ${GIF_FILE} / all frames dumped as _scratch-ib4p1-frame-NNN.png under ${OUT_DIR}/ for hand-picking"
