# LIA-475 — Composer tokenization highlighting + slash/@-mention autocomplete: visual verification record

Per `.claude/wardens/code-review-rules.md:100-104` (`visual-verification-artifact-required`, blocking) and
`docs/decisions/visual-verification-judge-pattern.md` (Decision 1 — this is a time-dimension feature, so a
terminal recording is required, a screenshot alone is not sufficient).

## Capture method

`artifacts/lia-475-composer-autocomplete/capture-harness.mjs` boots the REAL `tui-v2/AppContainer.tsx` Ink
component tree against a FAKE, in-memory `ChatTransport` — the same test-double pattern
`AppContainer.integration.test.tsx` already uses for this repo's own automated tests. `transport.status()`/
`turn()`/`respondPermission()`/`close()` never touch a socket. **This deliberately avoids the real production
`deus-native-chat` daemon** (pid recorded in `~/.config/deus-v2/native-chat.json`, serving live
WhatsApp/Telegram/credential-proxy traffic on this host) — no second daemon instance was started and the live
one was never touched, per this track's dispatch note. `cwd` is the real worktree checkout root (read-only
`fs.readdir`, never a write), so the `@`-mention scenario demonstrates real, cwd-backed directory listings
against this repo's actual `src/` tree rather than a fabricated fixture.

Driven via `tmux new-session -x 100 -y 30` (a real 100x30 pty) + `tmux send-keys` with per-keystroke delays,
recorded with `asciinema rec --window-size 100x30 -c "tmux attach -t <session>"`. `--window-size` was required
to match the tmux pty's real dimensions — the first capture attempt omitted it, asciinema's headless recorder
defaulted to an 80x24 virtual pty, and tmux cropped/reflowed the 100-wide UI into that narrower client view,
producing corrupted/ghosted frames in the resulting `.gif` (a recorder-configuration artifact, not a bug in the
implementation — confirmed by `tmux capture-pane` reading the session's own 100-wide buffer cleanly at every
step throughout). Both `before`/`after` recordings were redone with `--window-size 100x30` once this was
diagnosed; the files below are the corrected captures.

Derived formats: `.gif` via `agg` (default settings), `.txt` via `asciinema convert -f txt` (this format
renders the terminal and dumps its FINAL screen state as plain text — by construction it cannot represent a
time-dimension recording's intermediate frames, so both `.txt` files here are minimal/near-empty; the `.cast`
and `.gif` are the actual evidence), one representative `.png` per side via ImageMagick (`magick <gif>
frame-%02d.png`, then the cleanest frame picked by hand — index only, not proof by itself).

`before-*` was captured against the pre-diff code (`git stash` back to the original `Composer.tsx`/`App.tsx`/
`AppContainer.tsx`/`AppStateContext.ts`, harness re-run, then `git stash pop` to restore the implementation).

## BEFORE (pre-diff code)

**Feature:** Composer input has no tokenization highlighting and no autocomplete.
**Expected:** Typing `/`, `p`, `l` separately leaves `/pl` in one plain color; no dropdown appears.
**Observed:** `tmux capture-pane` after each keystroke showed `> /pl` with no color distinction and no dropdown
at any point. Confirmed both live (interactive `tmux capture-pane -p -e` ANSI inspection) and in
`before-composer-live-typing.cast`/`.gif`/`.png`.
**Disposition:** PASS (baseline behaves as expected — nothing to highlight or autocomplete pre-diff).

## AFTER (this diff)

### Scenario 1 — slash tokenization + live filtering
**Feature:** `/pl` should render the `/`-prefixed run in a visually distinct color from plain text at every
keystroke, and a dropdown should open on `/` and narrow live as the query grows.
**Expected:** After `/`, dropdown lists all 7 registered commands; after `p`, narrows to `/plan`/... entries
starting with `p`; after `l`, narrows to exactly `/plan`.
**Observed:** Confirmed via `tmux capture-pane` after each keystroke — dropdown showed all 7 commands after
`/`, then only `/plan` after `/pl`. ANSI inspection (`tmux capture-pane -p -e`) confirmed the slash token
renders bold + accent-colored, distinct from the primary-colored plain text around it. Recorded in
`after-composer-live-typing.cast`/`.gif`; representative frame in `after-composer-live-typing.png`.
**Disposition:** PASS.

### Scenario 2 — slash accept without submit
**Feature:** Down/Enter inside the slash dropdown should move the selection and insert the canonical command
text, without submitting the line.
**Expected:** From bare `/`, Down moves the highlighted row from `/plan` to `/status`; Enter replaces the
buffer with `/status` and does NOT submit (transcript stays empty / "No messages yet").
**Observed:** `tmux capture-pane` after Enter showed `> /status` in the composer and "No messages yet — type
below and press Enter." still displayed (i.e. no turn was submitted). Recorded in
`after-composer-live-typing.cast`/`.gif`.
**Disposition:** PASS.

### Scenario 3 — `@`-mention: cwd-backed suggestions + directory acceptance
**Feature:** Typing `review @src/cli` character by character should surface real, cwd-backed directory
listings that update as the path grows, and accepting a directory suggestion should replace only the active
mention and retain a trailing `/`.
**Expected:** After `@s`, root-level entries starting with `s` (e.g. `src/`) appear, `README.md` does not.
After `@src/`, `src/`'s real contents appear. After `@src/cli`, narrows to exactly `cli/`. Down+Enter replaces
the buffer with `review @src/cli/` (prefix preserved, trailing `/` retained), and the dropdown immediately
refreshes to `src/cli/`'s real contents.
**Observed:** All of the above confirmed via `tmux capture-pane` at each step against this actual worktree's
real `src/` directory (e.g. real entries like `agent-runtimes/`, `commands/`, `deus-native-chat-client.ts`
appeared, not fixture data). Recorded in `after-composer-live-typing.cast`/`.gif`.
**Disposition:** PASS.

### Scenario 4 — paste-placeholder distinct styling
**Feature:** A literal `[Pasted Text: N lines]` segment should render with distinct (italic, comment-colored)
styling from surrounding plain text. Explicitly NOT claiming this diff creates paste placeholders — no
paste-detection pipeline exists yet (out of scope, noted in the plan) — only that the tokenizer/renderer
recognizes and styles the literal string distinctly if one appears in the buffer.
**Expected:** `note [Pasted Text: 3 lines] end` renders the placeholder segment italic + comment-colored,
distinct from `note `/` end`'s primary color.
**Observed:** `tmux capture-pane -p -e` ANSI inspection showed the placeholder wrapped in `\x1b[3m` (italic)
with color `rgb(138,143,163)` (comment), while the surrounding plain text used `rgb(230,230,240)` (primary,
no italic). Recorded in `after-composer-live-typing.cast`/`.gif`.
**Disposition:** PASS.

## Independent judging — honest gap

Per `docs/decisions/visual-verification-judge-pattern.md`, the dedicated `visual-verification-judge` role
(dual-backend, cross-reviewed) is NOT yet wired — no code ships with that ADR. That ADR's own "Negative"
section states explicitly: *"Until that wiring lands, `visual-verification-required` and
`visual-verification-artifact-required` are satisfied by the record's existence, not by an actual judge
verdict."* This record's PASS dispositions above were assessed by the implementer (this session) reading the
real `tmux capture-pane` output and the real `.cast`/`.gif`/`.png` files at each step — not by an independent
human or a second model backend. That gap is named here rather than glossed over; an independent
cross-family/code-reviewer pass over this diff (see the commit's accompanying code-review round) is the
closest available substitute for now.
