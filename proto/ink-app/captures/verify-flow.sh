#!/usr/bin/env bash
# LIA-496 — S3 capture driver SKELETON for the "Transcript" (Ink) target.
# Scaffolded at S2B (BUILD) per this stage's dispatch — NOT run here. S3
# fills in real timings/wait conditions and actually executes this.
#
# Mirrors LIA-495's proven, established Ink capture pattern (proto/FINDINGS.md
# §4, migrated-ink-demo): a real 120x40 tmux pane running the app under
# `asciinema rec`, driven with genuine `tmux send-keys -l "<text>"` + a
# separate `Enter` (the same mechanism a human typing at the keyboard would
# produce — never a scripted prop injection), converted to gif via `agg`
# (ffmpeg is confirmed broken on this host, per LIA-495), with stills pulled
# from the gif via Python `PIL.Image.seek()`.
#
# Run from ink-app/ once S3 starts:  bash captures/verify-flow.sh
set -euo pipefail

SESSION="lia496-transcript-verify"
COLS=120
ROWS=40
OUT_DIR="captures/verify"
CAST_FILE="${OUT_DIR}/verify-flow.cast"
GIF_FILE="${OUT_DIR}/verify-flow.gif"

mkdir -p "${OUT_DIR}"

# --- 1. Fresh tmux pane, correct size, real terminal (not a pty stub). ---
tmux kill-session -t "${SESSION}" 2>/dev/null || true
tmux new-session -d -s "${SESSION}" -x "${COLS}" -y "${ROWS}"

# --- 2. Record the app under asciinema, driven with real keystrokes. ---
# TODO(S3): confirm `npx tsx src/main.tsx` is the right invocation once
# ink-app/package.json's `start` script is exercised for real (it is, per
# this file's own package.json — kept here as a literal double-check, not
# an assumption).
tmux send-keys -t "${SESSION}" -l "asciinema rec -c 'npx tsx src/main.tsx' ${CAST_FILE}"
tmux send-keys -t "${SESSION}" Enter
sleep 3 # TODO(S3): replace fixed sleeps with a real "app painted" wait condition (e.g. poll tmux capture-pane for a known string) rather than a guessed delay.

# --- 3. Scripted keystroke sequence — TODO(S3): fill in the exact sequence
# against the Must-tier feature list (§ Verification strategy, plan):
#   - sidebar seeded/grouped (today/yesterday headers visible on launch,
#     no keystroke needed)
#   - down-arrow to a non-highlighted thread, Enter — real keyboard thread
#     switch, confirms Sidebar.tsx's arrow+enter nav
#   - streaming mid-turn on the "status-glyph-fix" thread (turn 1: reasoning
#     -> Bash existence check -> permission prompt)
#   - "y" (allow once) on the delete_file prompt — confirms PermissionPrompt
#     resolves via a real keystroke, not a prop injection
#   - continued streaming into the Edit tool call -> DiffPanel card
#   - a SECOND user turn ("did that leave anything else stale in /tmp?")
#     driving turn 2's Bash call + markdown+shiki-highlighted closing text
#   - a THIRD user turn (grant-store proof) — only meaningful if turn 1 was
#     resolved with "a" (always allow) in a separate run; capture BOTH the
#     "a" and the plain "y" paths as two distinct .cast recordings, matching
#     shared/scripts/verify-headless.ts's own two-scenario design (granted
#     vs not-granted), not just one
#   - ctrl+n for a brand-new session -> EmptyState
#   - switch to "theme-swap-crash" -> ErrorState (real thrown Error, see
#     that thread's own shared/src/fixtures/conversations.ts comment)
#   - "d" on a highlighted thread -> delete-confirm box -> "n" to cancel
#     (never actually delete a seeded thread mid-capture — confirm the
#     confirm-box renders and cancels cleanly instead)
tmux send-keys -t "${SESSION}" -l "TODO_S3_FILL_IN_KEYSTROKE_SEQUENCE"
tmux send-keys -t "${SESSION}" Enter
sleep 5 # TODO(S3): same fixed-sleep caveat as above.

# --- 4. Stop the recording. ---
tmux send-keys -t "${SESSION}" C-c
sleep 1
tmux send-keys -t "${SESSION}" -l "exit"
tmux send-keys -t "${SESSION}" Enter
sleep 1
tmux kill-session -t "${SESSION}" 2>/dev/null || true

# --- 5. .cast -> .gif via agg (ffmpeg is broken on this host, per LIA-495). ---
agg "${CAST_FILE}" "${GIF_FILE}"

# --- 6. Stills via PIL.Image.seek() — TODO(S3): pick real frame indices
# once the .gif's actual frame timing is known (LIA-495 used 5 stills named
# for what they prove, not for a fixed cadence — do the same here, not a
# generic 1/2/3/4/5).
python3 - "${GIF_FILE}" "${OUT_DIR}" <<'PY'
import sys
from PIL import Image

gif_path, out_dir = sys.argv[1], sys.argv[2]
# TODO(S3): replace with the real frame indices + descriptive filenames
# once the actual capture exists, matching LIA-495's naming convention
# (e.g. "03-permission-prompt.png", not "frame-03.png").
FRAME_INDICES = {
    "01-TODO-initial-sidebar.png": 0,
}
im = Image.open(gif_path)
for name, index in FRAME_INDICES.items():
    im.seek(index)
    im.convert("RGB").save(f"{out_dir}/{name}")
PY

echo "Done — .cast/.gif/.png artifacts written under ${OUT_DIR}/ (S3 fills in the real keystroke sequence and frame picks above)."
