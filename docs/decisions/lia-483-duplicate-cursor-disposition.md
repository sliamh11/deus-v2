# LIA-483: Duplicate-Cursor Report — Capture-Timing Artifact, No Fix Needed

**Status:** Resolved — no source change
**Date:** 2026-07-26
**Scope:** none (verification-only; no files under `src/` touched)
**Ticket:** LIA-483
**Related:** [deus-tui-ink-rendering-layer.md](deus-tui-ink-rendering-layer.md) (LIA-471/473) —
covers the same `tui-v2` Ink rendering layer this report is about; has no
cursor-handling decision and is not superseded by this note.

## Report

LIA-478's visual audit artifact `16-idle-empty-state.png` appeared to show
two cursor glyphs on the idle composer screen: the intentional synthetic
inverse-space cursor (`<Text inverse> </Text>` in
`src/cli/tui-v2/components/Composer.tsx:153`) plus a stray native block
cursor on the line below. LIA-483 was opened against the brief's stated
root cause: Deus's own app code never explicitly hides the native
terminal cursor around Ink's render.

## Investigation

That root cause is real but incomplete: the pinned Ink fork
(`@jrichman/ink@6.6.9`, `package.json:55` / `package-lock.json:5526`)
already hides/shows the native cursor internally via its transitive
`cli-cursor@4.0.0` dependency —
`node_modules/ink/build/components/App.js:96` (`componentDidMount` →
`cliCursor.hide(this.props.stdout)`) and `:99`
(`componentWillUnmount` → `cliCursor.show(this.props.stdout)`), same
pattern in `node_modules/ink/build/log-update.js:3,63,70`. Adding a second,
app-owned raw-ANSI hide/show pair around `inkRender()` (the brief's
"likely fix") would create a competing lifecycle owner without changing
when Ink itself restores the cursor — it would not have changed the
audited artifact.

Grepping every LIA-478 `.cast` file for `\[?25l`/`\[?25h` showed exactly 2
hide sequences early in the recording and exactly 3 show sequences only at
teardown, seconds later — consistent with the reviewed PNGs being
end-of-recording frames captured **after** Ink's own restore, not live
frames.

## Verification (this diff)

**Feature:** `tui-v2` idle empty-state screen — the composer's idle `> `
prompt line, same named screen as LIA-478's `16-idle-empty-state.png`.

**Method:** Rebuilt the real entrypoint (`npx tsc`, root `tsconfig.json`)
and ran it against the actually-running `deus-v2-mvp` daemon (discovery
record at `~/.config/deus-v2/native-chat.json`, pid confirmed live) inside
a detached tmux pane (100×30, `tmux-256color`) with `asciinema rec`, same
pipeline LIA-478 used. Recorded three real completion paths:

1. Idle render, left running ~5s, then `Ctrl+C`.
2. Idle render, then `/exit` submitted through the composer.
3. `node dist/cli/tui/deus-tui-entry.js < /dev/null` (non-TTY).

For (1), the raw `.cast` was truncated to the events strictly before the
first `\x1b[?25h` (cursor-show) event, then rendered with `agg` and the
final GIF frame extracted with Pillow — the same technique LIA-478 used,
applied to a **pre-teardown** cut instead of the full recording. This
reconstructs the actual live-render pixels via the real terminal-cell
rendering pipeline, not the process's exit-frame.

**Expected (frozen by the shipped plan, `PLAN.md`):** the corrected live
frame shows exactly one cursor glyph (the synthetic inverse-space cursor);
zero cursor-show events occur before that frame; at least one show event
occurs at/after teardown on every completion path; the non-TTY path emits
no cursor escape bytes at all.

**Observed:**

- Live pre-teardown frame:
  [`artifacts/lia-483/live-pre-teardown-idle-empty-state.png`](artifacts/lia-483/live-pre-teardown-idle-empty-state.png) —
  exactly **one** cursor glyph at the composer position.
- Reference (LIA-478, post-teardown) for comparison:
  [`artifacts/lia-483/lia478-post-teardown-reference-idle-empty-state.png`](artifacts/lia-483/lia478-post-teardown-reference-idle-empty-state.png) —
  **two** glyphs (synthetic cursor + stray native cursor below it).
- Cursor-byte ordering, all three paths (grep `\[?25l\|\[?25h` on each
  fresh `.cast`):
  - `Ctrl+C`: hides at `0.431`/`+0.000`s; shows only at `+12.421`/`+0.000`/`+0.004`s (teardown).
  - `/exit`: hides at `0.325`/`+0.000`s; shows only at `+31.902`/`+0.001`/`+0.003`s (teardown).
  - Both: shell prompt with a normal visible cursor observed immediately after exit — restoration confirmed, not just the byte emitted.
  - Non-TTY: exit code `1`, `deus tui requires an interactive terminal; use \`deus chat\` for scripted/CI usage.` on stderr, **zero** `\[?25l`/`\[?25h` bytes in stdout or stderr.

**Disposition: PASS — reclassify as an LIA-478 capture-methodology
artifact.** The live render shows exactly one cursor glyph on every
completion path exercised. No `tui-v2` source file is changed by this
diff. The originally-proposed raw-ANSI wrapper around `inkRender()` was
correctly rejected by the shipped plan — implementing it would not have
changed the (already capture-artifact) evidence and would have added a
second competing cursor-lifecycle owner alongside Ink's own.

**Coverage limit:** the thrown-render-error completion path was verified
by reading Ink's error-boundary/`signal-exit`/raw-mode-Ctrl+C code paths
(cited above and in `PLAN.md`), not by a live forced-throw repro in this
diff — the three paths above (`Ctrl+C`, `/exit`, non-TTY) are the ones
carrying a live captured artifact.
