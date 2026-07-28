# LIA-494 — @ai-sdk/tui evaluation: findings

Throwaway prototype evaluating `@ai-sdk/tui` (v1.0.38) as a rendering
foundation candidate for `tui-v2`, specifically the permission-prompt and
tool-diff-rendering screens. Not wired into the real app's dependency tree.
Reference artifact for a human decision — not a mergeable feature, no PR
opened.

## Screen 1 — permission prompt (`src/screen1-permission.tsx`)

- Built successfully. 317 lines (verified via `wc -l`, matches self-report).
- Artifacts (verified present on disk):
  - `captures/screen1-permission.cast`
  - `captures/screen1-permission.gif` (857x608 GIF89a)
- Approach: fully custom Ink screen, not a wrapper around `runAgentTUI`'s
  non-exported renderer escape hatch — matches the setup stage's own
  recommendation for this situation.
- Decision logic ported **verbatim** (not reinvented) from the real
  production files, read first-hand before writing any code:
  - `deus-v2-mvp/src/cli/tui-v2/deus-tui-permission-decision-v2.ts` —
    `permissionListKeyToResult` (oracle-tested: Enter checked first, hard
    clamp at both list ends).
  - `deus-v2-mvp/src/cli/tui-v2/components/PermissionModal.tsx` — visual
    contract (selected-row bullet marker, distinctly-tinted "always allow",
    auto-deny countdown).
  - Codegraph wasn't initialized in `deus-v2-mvp`, so exploration correctly
    fell back to grep/find per the exploration protocol's stage-3 fallback.
- `@ai-sdk/tui`'s only real contribution to this screen: the confirmed
  finding that its tool-approval primitive is binary (see "Approval
  primitive finding" below) — everything else (3-way state, the
  `alwaysAllowed` Set, decision log) is plain Ink/React with zero library
  involvement.
- Verification: driven end-to-end live via tmux keypresses (Down/Down/Enter
  sequences) covering all three decision paths (`allow_once`,
  `allow_always`, `deny`) plus the auto-approved-no-prompt repeat (demo
  queue deliberately repeats the `Bash` tool name to make the always-allow
  persistence visible in the capture, not just claimed) — observed directly
  via `tmux capture-pane` before finalizing the recording. Not a single
  contrived path.
- Environment friction (non-blocking): local `ffmpeg` is broken
  (`Library not loaded: libx265.215.dylib`, stale homebrew x265), so a
  supplementary PNG frame-extraction via ffmpeg failed. Did not block the
  deliverable — `agg` (unaffected) rendered the full `.cast` to `.gif`
  successfully, and the `.cast` itself was captured with
  `--window-size 100x30` matching the tmux pane size.

## Screen 2 — tool result + diff rendering (`src/screen2-tool-diff.tsx`)

- Built successfully. File is 315 lines total (verified via `wc -l`,
  matches self-report exactly); roughly 85 of those are a file-header
  provenance comment citing exact source files/lines for ported logic (this
  repo's convention), leaving ~230 effective lines.
- Artifacts (verified present on disk):
  - `captures/screen2-tool-diff.cast`
  - `captures/screen2-tool-diff.gif` (857x608 GIF89a)
  - `captures/screen2-tool-diff-frame.png` (857x608 PNG)
  - `captures/screen2-tool-diff-frame-success.png` (857x608 PNG)
- Approach: fully custom Ink screen rendering fixture data directly.
  `@ai-sdk/tui` contributed nothing beyond being evaluated and ruled out —
  its only export (`runAgentTUI`) drives a live agent/transport loop, and
  its `AgentTUIRenderer` escape hatch is undocumented/unexported, so
  fighting it for a static-fixture demo would be pure friction with no
  payoff. Ink itself (already a transitive dep of `@ai-sdk/tui`) supplied
  everything needed (`Box`/`Text`, `borderStyle='round'`, per-`Text` color
  props, `wrap='truncate-end'`).
- Logic reused **verbatim** from Deus's real production files, read
  directly (from `deus-v2-mvp/.claude/worktrees/lia-474-diff-pipeline` and
  the main checkout) before writing any code:
  - `ToolMessage.tsx` — exhaustive `statusGlyph()` switch
    (success→✓/green, error→✗/red, unknown→?/yellow, `never`-checked
    default).
  - `types.ts` — `ToolCallStatus` union.
  - `ToolResultDisplay.tsx` / `DiffRenderer.tsx` — `ToolResultContent`,
    `parseDiffWithLineNumbers`, `DiffLine` shapes.
  - Stated (not silent) simplifications: no `themeManager`/
    `SemanticColors`, no `CodeColorizer` syntax highlighting, no
    `MaxSizedBox` scroll-clamping — all out of scope for what this
    evaluation is testing.
- Regression guard: a runtime `assertNoFalsePositiveCheckmark()` check
  (confirmed present at `src/screen2-tool-diff.tsx:265`, called at line
  275) that throws if any non-success status ever produces a glyph
  containing a checkmark — reproduces the real LIA-474 regression case as
  a genuine check, not just eyeballed. Frames were visually confirmed: the
  denied/error case renders red ✗ with no green ✓ anywhere in that box, and
  the unknown case renders yellow `?`.
- Environment friction (both worked around, neither blocking): (1) macOS
  zsh has no `timeout` builtin — used `script -q` for the first
  non-recorded smoke run; (2) `ffmpeg` broken on this host (same
  `libx265.215.dylib` gap as screen 1) — worked around with PIL (already
  available) to seek frames directly out of the `agg`-produced GIF for the
  static preview PNGs, instead of ffmpeg frame extraction.
- `asciinema`+`agg` (the proven LIA-475 pattern) worked cleanly on the
  first try with `--window-size 100x30`, producing a real 10-frame
  animated GIF (frame count verified via PIL) plus the raw `.cast`.
- Did not touch the sibling `screen1-permission.tsx`, did not run
  `npm install`, made no git commits — left everything for this reconcile
  stage.

## Approval-primitive finding (from the setup stage, independently re-confirmed here)

**CONFIRMED BY READING SOURCE** (not docs, not assumption) —
`@ai-sdk/tui`'s tool-approval primitive is **strictly binary**, at both the
type level and the default UI level. There is no "always allow"/persistent-
grant concept anywhere in the library.

Mechanism, in order (re-verified directly against
`node_modules/@ai-sdk/tui/src/*` in this worktree before writing this
document):

1. **Type contract** — `AgentTUIToolApprovalResponse`
   (`agent-tui-runner.ts:65-68`): `{ approved: boolean; reason?: string }`.
   No third state, no scope/persistence field.
2. **Default UI** — `TerminalRenderer.readToolApproval`
   (`tui/terminal-renderer.ts:327-382`): sets status text
   `Approve <tool>? y/n`, and its raw-keystroke handler (lines 342-357)
   checks only `value === 'y'` → `resolve({approved: true})` and
   `value === 'n'` → `resolve({approved: false, reason: 'Denied by user.'})`.
   Every other character is ignored. No `a`/always key, no session-level
   memory of prior decisions — each `readToolApproval` call is stateless
   and independent.
3. **Runner loop** (`agent-tui-runner.ts:169-197`): calls
   `readToolApproval` once per pending approval-requested part, every time
   one appears; the only way a tool skips the prompt is if the upstream
   stream already marked `part.approval.isAutomatic === true` before it
   reaches the runner (i.e. some agent/model-side policy pre-approved it) —
   the runner/renderer has no mechanism to set that itself.

**Conclusion:** the library provides the wire primitive (`approved: boolean`
+ optional `reason`) needed for a three-way UI, but not the three-way UI or
the "remember this decision" behavior itself. To replicate Deus's real
`allow_once` / `allow_always` / `deny` flow (as seen in the real production
`PermissionModal.tsx`, which already solves this with its own
`PermissionListKeypress`/`permissionListKeyToResult` reducer and a
`cursorIndex`-driven 3-row list), the demo/eventual screen must supply a
**custom** `readToolApproval` implementation (via the renderer escape hatch,
or by building a fully custom Ink screen independent of `runAgentTUI`, as
both screens in this prototype do) that: (a) renders its own 3-option UI,
(b) on "allow always" additionally records the tool's identity in its own
local state (e.g. a `Set<string>` of tool names/signatures) so future
approval requests for that same tool can be auto-resolved to
`{approved: true}` without prompting again, before ever calling the
library's `readToolApproval`. This is a consumer-side responsibility in
every case — `@ai-sdk/tui` has no first-class support for it, contrary to
what the binary y/n framing in its default renderer might suggest.

## Adaptation-cost summary for `@ai-sdk/tui` as a tui-v2 rendering foundation candidate

Both screens converge on the same result: **`@ai-sdk/tui` itself
contributed essentially nothing to either screen beyond a confirmed
negative finding.** Its only public export, `runAgentTUI`, is built around
driving a live agent/transport streaming loop with a binary approve/deny
primitive and an internal, unexported renderer. Neither the permission
screen's 3-way decision model nor the diff screen's static fixture
rendering fit that shape, and the library's escape hatch
(`AgentTUIRenderer` duck-typing) is undocumented and unexported — not a
supported extension point. Both agents independently reached the same
conclusion (evaluated the library, then built fully custom Ink screens
instead of fighting it), which is corroborating rather than duplicated
effort: it is two independent tests of the same hypothesis landing on the
same answer.

What `@ai-sdk/tui` *does* buy is indirect: it pulls in Ink as a transitive
dependency, and Ink alone (Box/Text primitives, border styles, color props,
text wrapping) was sufficient for both screens. If tui-v2 adopts
`@ai-sdk/tui`, that adoption is really "adopt Ink" plus "get a live-loop
agent runner we don't currently need for these two screens" — the
approval-flow and diff/status-rendering UX work has to be built from
scratch either way, verbatim-ported from the existing, already-correct
production code (`PermissionModal.tsx` / `deus-tui-permission-decision-v2.ts`
for approval; `ToolMessage.tsx` / `ToolResultDisplay.tsx` / `DiffRenderer.tsx`
for diff rendering).

**Net honest assessment:** this is not evidence *against* `@ai-sdk/tui` as a
foundation — the live-agent-loop runner it provides may still be valuable
for the parts of tui-v2 that do need a streaming agent loop, and adopting it
costs little beyond a normal dependency add (small, focused package; the
disqualifying `ffmpeg`/ffmpeg-dylib issues were host-environment problems
unrelated to the library). But for the two screens actually evaluated here
— permission prompting and tool-diff rendering — it supplies no meaningful
scaffolding over building directly on Ink, and any decision to adopt it
should rest on its value for the live-agent-loop surfaces, not on these two
screens.

## Discrepancies found during reconcile verification (round 2)

None. Every claim in both agents' self-reports (file paths, artifact paths,
LOC counts, source-line citations for the approval-primitive finding,
presence of the `assertNoFalsePositiveCheckmark` guard, GIF dimensions/
format) was independently confirmed against the actual files on disk and
against `node_modules/@ai-sdk/tui`'s real source before being written into
this document.

## Round 3 — Claude Code design mimicry + feature exploration

Three concurrent tasks: restyle both screens onto the Claude Code
design-language spec (`spec-and-plan.md`), and build a real protocol-level
spike answering a new feature-exploration question about `@ai-sdk/tui`'s
`runAgentTUI({ transport })` execution loop. All claims below were
independently re-verified against the actual files on disk in this
reconcile stage, not copy-pasted from the self-reports.

### Screen 1 — permission prompt: what changed and why

`src/screen1-permission.tsx` (now 434 lines, verified via `wc -l`, includes
the round-3 auto-deny fix below) was restyled to the spec's
numbered rounded-panel layout while the ported decision logic
(`permissionListKeyToResult`, hard-clamp cursor bounds, `toLibraryResponse`,
the consumer-owned `alwaysAllowed` Set) was kept byte-for-byte unchanged, per
the spec's explicit instruction that this logic is the behavior under
evaluation, not the chrome around it. Visual/interaction changes: a `TOKENS`
hex-color object replacing Ink's named colors; the panel redesigned around
title/`⏺ ToolName`/preview/auto-deny-countdown/numbered `1./2./3.` options
with a `›` selected marker; direct 1/2/3 digit-key selection added as an
input path alongside arrows+Enter; an OSC 8 file-path hyperlink helper
(`toFileUrl`/`osc8Link`/`FilePathLink`) for tool calls that target a file;
`DecisionLine` redesigned around a stateful `⏺` glyph (muted → green/red)
with the old `[wire: approved=...]` diagnostic text removed and an
`accent.info` `scopeNote` added for persistent-scope decisions; the
prototype title/explanatory paragraph removed from `App`.

### Screen 2 — diff screen: what changed and why

`src/screen2-tool-diff.tsx` (now 510 lines, verified via `wc -l`, includes
the round-3 code-review fixes below; fully custom Ink, no
`@ai-sdk/tui` involvement — unchanged conclusion from round 2) was restyled
similarly: the same `TOKENS` hex-color convention; `statusGlyph()`'s three
glyph families (✓/✗/?) replaced by `toolCallState()`, an exhaustive
`never`-checked switch that always returns the canonical `⏺` bullet varying
only by color (the "stateful bullet" convention); the regression guard
renamed to `assertNoFalsePositiveSuccessColor()` since checking for a
checkmark glyph is meaningless once every state renders the same bullet;
`parseDiff()` extended to track old/new line numbers per hunk, plus
`foldContext()`/`truncate()` for a line-numbered, capped diff view; a real
OSC 8 hyperlink (`hyperlinkPath()`) for the diff filename; `ToolMessage`
collapsed from two boxes to one unboxed header line + one rounded result
panel (error-tinted border for non-success); a "Proposed changes — not
applied" label for denied/failed diffs.

### Artifacts (verified present on disk, freshly regenerated this round)

- `captures/screen1-permission.cast`, `.gif` (regenerated for the redesign)
- `captures/permission-unresolved-frame.png`,
  `permission-mid-frame.png`, `permission-last-frame.png`
- `captures/screen2-tool-diff.cast`, `.gif` (re-regenerated after the
  round-3 code-review fixes below, at a taller 100x55 window so all three
  fixtures are visible unclipped in a single frame)
- `captures/screen2-tool-diff-frame-success.png`,
  `-frame-denied.png`, `-frame-unknown.png` (re-cropped from the post-fix
  gif — `-frame-denied.png` is the artifact that visually proves finding #1
  is fixed: the diff body and `+1 -1` stat now render muted gray, not
  green/red)
- `captures/transport-runner-spike.cast`, `.gif`,
  `-frame-full.png`, `-output.txt`
- `captures/screen1-autodeny-fix.cast`, `.gif`, `-frame.png` (new this
  round: an unattended run of `screen1-permission.tsx` with zero keypresses,
  letting the countdown resolve all four queue entries by timeout. The
  final frame shows all four entries denied — red bullets — and "All
  requests resolved. Exiting..." reached on its own, which is the artifact
  proving finding #2 is fixed: before the fix this state was structurally
  unreachable without a manual keypress, since the countdown never actually
  fired a decision)

All seventeen paths were confirmed with `ls`/existence checks against this
worktree, not assumed from the self-report. One stale-named file from a
prior round, `captures/screen2-tool-diff-frame.png`, is removed (replaced by
the three per-fixture-named PNGs above) — reflected in `git status` as a
deletion.

### Code-review outcome: REVISE → fixed → re-verified

GPT-5.6-Sol (`codex exec -s read-only`) reviewed the redesign diff against
the spec and additionally ran the live TUI itself. Verdict: **REVISE**, 5
findings. This reconcile stage independently re-derived findings 1-4 from
the actual code before accepting them (per this repo's delegated-conclusion
discipline), fixed all four, and re-verified each fix — two live at
runtime, one via a standalone Node encoding check, one by direct byte-level
inspection of the fixture string:

1. **HIGH — false-positive success styling on denied diffs.** `+` lines and
   the `+N` stat were colored `semantic.success` unconditionally, ignoring
   `notApplied`. **Fixed**: `renderDiffLine()` now takes a `notApplied`
   parameter and collapses add/del line coloring (and the `+N`/`-M` stat
   colors) to `text.muted` whenever the diff wasn't actually applied.
   **Re-verified live**: ran `screen2-tool-diff.tsx`'s denied fixture
   (`src/config/secrets.ts`) and confirmed via raw ANSI byte inspection that
   every diff-body line and the `+1 -1` stat now render in
   `38;2;176;174;165` (muted), not green/red.
2. **HIGH — the auto-deny countdown never actually denied.** The countdown
   `useEffect` only updated the displayed `remainingMs`; no code path ever
   called `onDecision('deny')` at 0, so "auto-denies in 0s" sat there
   indefinitely (codex observed this in its own live run). **Fixed**: the
   interval now reads `onDecision` through a ref (avoiding an
   effect-dependency reset loop) and calls `onDecisionRef.current('deny')`
   plus clears itself once `remaining <= 0`. **Re-verified live**: ran
   `screen1-permission.tsx` in a fresh tmux session, watched the first
   prompt's countdown reach 0, and confirmed via raw ANSI byte inspection
   that the queue actually advanced to the second prompt with a fresh
   10s countdown, with the resolved log line rendered in
   `38;2;185;92;80` (`semantic.error` — correctly a real deny, not a stall).
3. **HIGH — broken OSC 8 target for paths with `#`/`?`.** `hyperlinkPath()`
   used `encodeURI(absolute)`, which does not escape `#` or `?`, corrupting
   the `file://` target for such paths. **Fixed**: switched to per-segment
   `encodeURIComponent` (matching `screen1-permission.tsx`'s existing
   `toFileUrl` pattern) so every reserved character in a path segment is
   escaped while `/` separators survive. **Re-verified**: a standalone Node
   check confirms `src/weird#name?with spaces.ts` now percent-encodes to
   `...src/weird%23name%3Fwith%20spaces.ts` instead of leaving `#`/`?` raw.
4. **MEDIUM — fixture line-number drift.** `SUCCESS_DIFF`'s blank context
   line (between the `add`/`sub` hunks) was missing its required leading
   space; `parseDiff()` silently dropped any line matching none of
   `+`/`-`/` `, so that line never incremented the old/new counters and
   every subsequent line's displayed gutter number was off by one relative
   to its real position. **Fixed**: added the leading space so the blank
   line parses as a context line. **Re-verified**: re-ran the fixture live
   and confirmed the rendered gutter now increments continuously
   (`1 1`→`2` /`2`→`3 3`→`4 4`→`5`/`5`→`6 6`→`7 7`→`8`→`9`→`10`→`11`) with
   no skipped/duplicated line number across the blank line.
5. **MEDIUM — `FINDINGS.md` was stale** (wrong LOC counts, referenced the
   removed `assertNoFalsePositiveCheckmark` name, described the old glyph
   scheme). **Fixed**: this round-3 section documents the current state;
   round 1/2 sections above are left as historical record, not rewritten.

After the fixes: `npx tsc --noEmit` is clean (exit 0, no errors) for both
screens, and no library-honesty regression exists — both screens remain
consumer-owned custom Ink, `@ai-sdk/tui` is not credited for any of this
styling, matching codex's own explicit "no library-honesty finding" note.
**Final verdict: REVISE → all 4 code findings fixed and re-verified → SHIP**
(the 5th finding, FINDINGS.md staleness, is resolved by this section itself).

### Spike — `runAgentTUI({ transport })` as a thin harness over Deus's transport

**Question posed by the spec:** "Can `runAgentTUI` act as a thin terminal
harness over Deus's existing HTTP `ChatTransport` without taking ownership
of session history, permissions, or tool execution?"

This reconcile stage re-read `src/transport-runner-spike.tsx` in full (not
just the self-report) and independently re-ran it fresh
(`npx tsx src/transport-runner-spike.tsx`), reproducing the identical
output: exit code 0, 5 scenarios (1 `[PASS]`, 4 `[PARTIAL]`), and the same
closing verdict text. The spike's most load-bearing citations were also
independently checked against the real production files rather than trusted
from the file's own comments:
- `DeusChatTransport`'s `turn`/`respondPermission`/`setPlanMode`/`status`/
  `close` shape matches the real `ChatTransport` interface in
  `deus-v2-mvp/src/cli/deus-native-chat-client.ts` verbatim.
- `PermissionDecision = 'allow_once' | 'allow_always' | 'deny'` matches
  `src/agent-runtimes/types.ts:122` exactly.
- The route table (`turn`/`status`/`close`/`plan`/`permission-response`,
  five routes, no history-read route) matches
  `deus-v2-mvp/src/cli/deus-native-chat-server.ts` exactly.
- `grep -n "AbortSignal\|signal" deus-native-chat-client.ts` returns zero
  matches, confirming the spike's cancellation-gap claim.
- `grep -c "reconnectToStream" node_modules/@ai-sdk/tui/src/agent-tui-runner.ts`
  returns `0`, confirming the spike's restart/reconnect-gap claim.
- `permission_request` in `types.ts` does carry the comment "Not yet
  produced by any production runtime" cited by the spike — a real caveat on
  the whole exercise (the fixture stands in for a runtime capability Deus
  itself doesn't produce yet).

**Verified conclusion (mechanism → answer, not just repeated verdict text):**
NO — `runAgentTUI({ transport })` cannot act as a thin, ownership-free
harness over Deus's real transport, for two independently-confirmed
structural reasons, not just one glancing gap:
- **Session continuity fails outright.** `RunAgentTUIOptions`/
  `AgentTUISessionOptions` have no history/resume field and the runner never
  calls `reconnectToStream` (0 grep matches, confirmed above), so a
  restarted TUI always starts with an empty local `messages` array and a
  fresh `chatId` — even though the fixture's own daemon correctly retained
  real session continuity underneath, proving the daemon side is fine and
  the gap is entirely on the runner/adapter side. This directly fails the
  spec's bar of "preserve the daemon's group session across restarts."
- **Approval handling is lossy.** `AgentTUIToolApprovalResponse = {approved:
  boolean; reason?}` has no field for `allow_always` at all, so a 3-way
  Deus decision cannot cross this boundary without the adapter inventing
  out-of-band state the library has no concept of — directly failing the
  spec's bar of representing `allow_once`/`allow_always`/`deny` "without
  lossy or duplicate approval handling."
Per the spec's own explicit adoption rule ("if not, stop at custom Ink
rendering"), both failures independently trigger that rule. **This spike's
answer does not overturn rounds 1-2's conclusion** — it reinforces it from a
different angle (the live-agent-loop runner, not just the two static-ish
screens already evaluated): stop at custom Ink rendering for tui-v2. No
further `@ai-sdk/tui` capability merits exploring for this decision.

### Discrepancies found during round-3 reconcile verification

The 4 confirmed code findings above (all independently re-derived from the
code, not just accepted from codex's report, then fixed and re-verified —
see "Code-review outcome" section). No discrepancies found in either build
agent's file/artifact/spike claims themselves; all paths, LOC-adjacent
claims, and the spike's exit code, scenario outcomes, and cited
production-file line contents were independently confirmed against the
actual files in this worktree.

## Round 4 — full Claude Code app-shell mimicry (`src/full-shell.tsx`)

Rounds 1-3 evaluated `@ai-sdk/tui` through isolated pieces: two standalone
screens (permission prompt, tool-diff result) and a headless runner spike.
This round composes an entire shell into one runnable Ink app —
header/status bar, rotating-gerund spinner, multi-turn transcript with
genuinely streamed assistant text, an in-flow tool call resolving to a
diff, an inline permission prompt that interrupts and then resumes a live
session, a footer Tasks pill, and a composer — driven by one
scripted-but-live fixture conversation, so the recording shows the whole
experience flow rather than a gallery of disconnected clips.

`npx tsc --noEmit` is clean (exit 0) for `src/full-shell.tsx`.

### Capture (verified live, not assumed from the build report)

Captured with the same proven pattern as prior rounds: a 120x40 tmux
session (wider/taller than the usual 100x30 because the full shell's
header-to-footer height needs the extra rows to avoid clipping) running
`asciinema rec --window-size 120x40 captures/full-shell.cast -c 'npx tsx
src/full-shell.tsx'`, then converted with `agg`. The recording is one
continuous 18.74s session (confirmed by summing the cast file's own
relative timestamps), not a stitch of separate clips — including a real,
live keypress: the permission prompt was allowed to sit and count down
genuinely (confirmed via direct tmux `capture-pane` mid-countdown, e.g.
"auto-denies in 14s"/"12s"), then `tmux send-keys -t fullshell "1"` was
sent to press **1 (Allow once)**, and the flow visibly continued into the
diff, test run, and completion — not a hardcoded single path. Frame
timestamps for the diff/test/footer content were independently confirmed
against the cast file's own text stream (`grep`-equivalent search over the
decoded JSON lines), not guessed from wall-clock sleep durations, because
those two clocks diverge (tool-call reasoning time between `tmux
send-keys` calls elapses in the recording too) — an initial naive
timestamp guess for the "diff shown" still-frame in fact landed on an
earlier still-pending-permission frame and was caught and corrected this
way before being saved.

Artifacts (all verified present on disk with `ls`):

- `captures/full-shell.cast` (613 KB, 568 events, 18.74s)
- `captures/full-shell.gif` (426 KB, 150 frames)
- `captures/full-shell-frame-user-message.png` — composer mid-type, status
  "working", spinner "Pondering…"
- `captures/full-shell-frame-spinner-working.png` — user message landed in
  transcript, spinner "Percolating…", Tasks 0/3
- `captures/full-shell-frame-permission-prompt.png` — inline permission
  panel interrupting the transcript flow, live countdown ("auto-denies in
  14s"), cursor on option 1
- `captures/full-shell-frame-diff-shown.png` — permission resolved via the
  real "1" keypress, diff panel rendered (reusing screen2's
  parseDiff/DiffRenderer pipeline), Bash(npm test) tool firing, Tasks 1/3
- `captures/full-shell-frame-tests-passed.png` — test result panel ("42
  passed, 0 failed"), pre-final-summary
- `captures/full-shell-frame-footer-done.png` — final assistant summary
  streamed in full, Tasks 3/3 in `semantic.success` green, composer back
  at its idle placeholder

### Honest assessment: full-shell composition vs. isolated pieces

This is the useful signal distinct from the individual-screen findings
above. Composing the full shell did not surface any new `@ai-sdk/tui`
capability worth adopting, and it did surface one real cost isolated
screens hid:

- **No composition primitive existed to reuse.** Because
  `screen1-permission.tsx` and `screen2-tool-diff.tsx` each end in a
  top-level `render(<App/>)` with no exports, building the combined shell
  meant re-deriving (not importing) both pieces' logic into one file —
  the permission decision state machine and the diff pipeline were
  copied, not composed. `@ai-sdk/tui` offers no shell-level primitive
  (layout region, screen router, or session-transcript container) that
  would have made stitching these pieces together cheaper than plain Ink
  + custom state; the library's contribution to this file is identical to
  its contribution to rounds 1-2 (Ink as a transitive dependency only).
- **State coordination across pieces is where the real cost lives, and
  it's all hand-rolled.** The interesting engineering in this round —
  pausing the spinner during the permission pause and during streaming
  (per the spec's own display rule), threading one `ScriptCtx` through a
  linear async script so the transcript, tool calls, permission decision,
  and footer pill all stay consistent with a single source of truth, and
  branching the whole downstream flow on a genuinely-resolved decision
  rather than a hardcoded path — is ordinary React/Ink state management
  that `@ai-sdk/tui` neither helps nor hinders. Nothing about assembling
  the full shell surfaced a gap or a win specific to the library; it
  reconfirms rounds 1-3's conclusion (stop at custom Ink rendering for
  tui-v2) from the composition angle rather than changing it.
- **Positive note:** Ink itself (the library `@ai-sdk/tui` sits on top of)
  composed the full shell without friction — real chunked React state
  updates for streaming text, independent interval timers for the
  spinner's frame and word rotation, and a `useInput`-driven interrupt
  panel mid-flow all worked exactly as they did in isolation, with no
  full-shell-specific Ink limitation encountered.

## Round 5 — pushing `src/full-shell.tsx` to Ink's actual engineering ceiling

Round 4 already confirmed `@ai-sdk/tui`'s entire public export surface is
just `runAgentTUI` + option types (re-verified this round by reading
`node_modules/@ai-sdk/tui/dist/index.d.ts` directly), so there is no
additional *library* API left to evaluate — "take it to its limits" for
this library means pure Ink engineering. Three specific Ink capabilities
were added to the same `full-shell.tsx`, each verified for real rather
than assumed:

`npx tsc --noEmit` is clean (exit 0) after all changes below.

### 1. `<Static>`-backed scrollback (genuine, not cosmetic)

Settled transcript entries (a finished user turn, a completed assistant
message, a resolved tool call) now move into a `<Static>` list once they
can never mutate again (`isEntrySettled`); only the still-changing tail
(spinner, an in-flight tool call, the permission countdown, the composer)
re-renders in the live Ink tree below it.

**A real correctness bug was found and fixed during verification, not
just a cosmetic pass.** An early version tracked "is this assistant entry
still streaming" via a *separate* `streamingEntryId` App-level state,
updated with its own `setState` call alongside (but not atomically with)
the `setEntries` call that added the entry. A direct render-log
instrumentation test (temporarily logging `STATIC`/`LIVE` + entry
kind/id on every render, then `sort | uniq -c`) caught the entry
graduating into `<Static>` **twice** — once prematurely (for one render,
with empty streamed text, because `entries` already contained the new
entry but `streamingEntryId` hadn't committed yet) and once correctly
after streaming finished. Because `<Static>` can never un-print something
once it's graduated an item, the premature graduation would have baked a
blank/wrong line permanently into real terminal scrollback, followed
later by the correct line — a genuine visible defect, not a theoretical
one. Fix: moved the `streaming: boolean` flag onto the `Entry` object
itself, flipped in the exact same `setEntries` call as the text update,
so there is no cross-state race. Re-ran the same instrumentation after
the fix: every entry (`user`, `assistant` ×N, `tool` ×N) now appears in
`STATIC` exactly once, with `LIVE` occurrences only while genuinely
unsettled.

**Verified the actual scrollback effect**, not just the render count,
using `tmux pipe-pane -o 'cat >> file'` (captures the real bytes Ink
writes to a real interactive pty — the same rendering path
`asciinema`+tmux capture uses, confirmed distinct from running under
`script(1)`, which forces Ink into a full-screen-clear-every-frame
fallback path with zero incremental `ESC[nA` cursor-up sequences and was
discarded as a non-representative test environment after finding it gave
misleading counts for *both* the old and new code):

| | pre-round-5 (no `<Static>`) | round-5 (with `<Static>`, bug fixed) |
|---|---|---|
| `"Found it"` (settled Read-tool text) occurrences in ~7s | **31** | **1** |
| incremental live-region redraws (`ESC[<n>A` cursor-up) in the same window | 1210 | 1158 |

Same order of magnitude of live redraw activity in both (spinner ticks,
composer blink, permission countdown all still firing), but the settled
tool result is written once and never touched again only in the
round-5/`<Static>` version — direct, reproducible evidence the feature
does what it claims, not just that it compiles.

### 2. Real raw-mode composer

`Composer`'s `text` is now internal component state mutated *only* inside
its own `useInput` handler (character append, backspace/delete, Enter to
submit) — the same shape as the existing real `PermissionPrompt`. There
is exactly one code path that changes the text, whether a character comes
from a real key or the unattended-capture auto-fill fallback (a timer
advancing the identical `setText` call, structurally parallel to
`PermissionPrompt`'s auto-deny countdown).

**Verified with real keystrokes**, not a scripted string: inside a tmux
pane (`COMPOSER_AUTOFILL_DELAY_MS=30000` env override so the fallback
couldn't fire first), `tmux send-keys -l` sent literal characters one at a
time and a real `BSpace`, with `tmux capture-pane` after each:
`h` → `hello` → (backspace) `hell` → (backspace) `hel` → `hello real
keys`, then `Enter` submitted it and the scripted flow continued using
that actual typed text (echoed into the transcript verbatim, "hello real
keys" / "fix the date bug please" across separate runs) — genuine
character-by-character, backspace-capable, real-key-driven input, not a
prop injection.

**A real bug was found and fixed here too**: the auto-fill fallback never
fired in the `script(1)`-captured test environment, because
`realKeyReceivedRef.current = true` was set unconditionally at the top of
the `useInput` handler for *any* input — including stray control/escape
bytes the harness's pty apparently delivers before real keystrokes — which
permanently disabled the unattended fallback. Fixed by only marking "a
real key landed" inside the branches that actually act on input (return
with non-empty text, backspace/delete, escape, printable character),
never for ignored modifier/navigation combos. Re-verified unattended
playback still works end-to-end afterward (auto-typed fixture message,
full script run to completion, both the approve and the 15s-auto-deny
branches).

### 3. Real reactive terminal resize

`useTerminalSize()` (`useStdout()` + its own `'resize'` event) feeds a
`TerminalSizeContext` read by `Header` (a live `{columns}×{rows}`
readout) and `DiffRenderer` (live-width-aware content truncation with an
ellipsis, instead of `wrap="wrap"`, which would break the diff's
fixed-width gutter alignment on a wrapped continuation line).

**Verified by actually resizing a real tmux pane mid-session** (not
claimed): `tmux resize-window` from 100→60→130 columns while the
permission prompt was live showed the header readout change
(`100×34`→`60×34`→`130×40`) and every live-region bordered panel
(permission box, Tasks pill, composer) reflow to the new width in the
same frame — while the *already-settled* scrollback content above (the
Read tool's result, printed before the resize) visibly kept its original
width, exactly as real terminal scrollback must (already-printed rows
can't retroactively rewrap) — incidental further confirmation that item
1's settled/live split is real. Separately, a fresh run pinned at 40
columns for its entire lifetime showed the diff panel's lines genuinely
truncated with `…` (e.g. `const day = input.getDate(…`) and the box
border shrunk to fit — confirming the width-aware truncation logic
actually engages, not just that the prop is wired.

### Everything requested was completed — nothing skipped

All three items from the round-5 brief were implemented and verified
working for real (render-log instrumentation, `tmux send-keys`,
`tmux pipe-pane` byte capture, and `tmux resize-window`, as detailed
above), including two genuine bugs the verification process itself
surfaced and fixed before shipping. No item was found impractical for
this fixture.

## Round 6 — independent re-verification + one real recording of round 5's work

Round 5's self-report was re-verified firsthand rather than trusted, a
real `asciinema` recording was captured of the enhanced shell, and one
genuine methodology bug in the *capture pipeline itself* (not the app)
was found and worked around.

### Re-verification of round 5's claims

- `npx tsc --noEmit` re-run clean (exit 0, zero output) against the
  worktree as handed off.
- Read `full-shell.tsx` directly and confirmed `Static`, `useInput`,
  `useStdout`, `isEntrySettled`, `TerminalSizeContext`, and
  `realKeyReceivedRef` are all genuinely wired into the render tree and
  the `Composer`/`PermissionPrompt` input handlers — not vestigial
  imports (`grep -n` line numbers checked against the actual JSX:
  `<Static items={historyEntries}>` at line 1168, `useInput(...,
  { isActive: isListening })` in `Composer` at line 851,
  `stdout.on('resize', ...)` in `useTerminalSize` at line 139).
- Independently re-drove the composer with real `tmux send-keys -l`
  keystrokes (not the ones round 5 already ran) — typed `hello real
  keys`, sent 5 individual `BSpace` presses, confirmed each intermediate
  state via `tmux capture-pane` (`hello real keys` → `hello real`,
  exactly 5 chars removed), then `Escape` to clear (confirmed empty),
  then typed the real fixture message and submitted with `Enter`. All
  matches round 5's claimed mechanism.
- Independently drove a live `tmux resize-window` (100×34 mid-session,
  then narrower) against the actual running process and watched the
  header readout and every live-region panel (permission box, Tasks
  pill, composer) reflow in the same frame, while already-settled
  `Static` scrollback above kept its original width — same effect round
  5 reported, reproduced independently.

### A real capture-pipeline bug found and worked around: `asciinema --window-size` silently blocks resize propagation

While producing this round's recording, the very first take used
`asciinema rec --window-size 120x40 ...` (the flag this repo's own
capture convention has used since round 1, and what this round's
instructions suggested). Under that flag, **`tmux resize-window` on the
recording pane had no effect on the recorded process at all** — the
app's header stayed pinned at `120×40` no matter how many times or how
long after the resize command was given (confirmed: repeated
`resize-window` calls with up to 2s settle time, both with and without
`asciinema` in the loop).

Root-caused by isolating the layers: a bare `node -e` script listening
for `stdout`'s `'resize'` event, run directly in the same tmux pane with
no `asciinema` involved, **did** receive `resize` events from
`tmux resize-window` after a short settle delay. The same script run
under `asciinema rec --window-size 100x30 --command '...'` **never**
received a single `resize` event, no matter what the outer tmux pane was
resized to — confirmed by grepping the produced `.cast` file: zero
`"resize"`-carrying output, vs. the terminal's own live pane visibly
reflowing (proving the *outer* tmux layer did resize; the *inner* pty
`asciinema` hands its child never got the update). This matches
`asciinema rec --help`'s own description of `--window-size`: it
"override[s] the terminal window size **used for the recording
session**" — i.e. it pins the recording's pty to a fixed size and does
not forward subsequent live resizes to the child process at all. This is
a real, verified limitation of the *capture tool*, not of `full-shell.tsx`
or Ink — round 5's resize claim is genuine when watched directly in a
live pty (as round 5 did, and as this round re-verified), but it cannot
be captured live in an `asciinema` recording that uses
`--window-size`.

**Workaround**: omit `--window-size` entirely and let `asciinema`
inherit the tmux pane's actual (dynamic) size. Re-tested the same
bare-`node` resize probe under `asciinema rec` with no `--window-size`
flag: the `resize` event fired and its output (`RZ 70 25`) was captured
into the live pane text asciinema records, confirming the child process
genuinely receives live resizes this way. `captures/limits-push.cast`
was produced with this fix (`asciinema rec captures/limits-push.cast
--overwrite --command '...'`, no `--window-size`), and directly grepping
the resulting `.cast` file confirms both resized states appear in the
recorded byte stream (`90×34` appears 11 times, `60×30` appears 43
times, across the post-resize portion of the session) — the resize is
genuinely on tape, not just observed live.

Flagging this because every prior round's captures in this directory
used `--window-size`, which means **none of the earlier `.cast`/`.gif`
files in this directory can show a live resize even if one had been
attempted during their recording** — this wasn't a problem before
because no earlier round exercised live resize on tape. Future rounds
that want to record a resize should drop `--window-size` (or resize
before starting the recording and pick a single fixed size, if a
deterministic frame size matters more than showing the live transition).

### This round's recording

`captures/limits-push.cast` / `captures/limits-push.gif` — one
continuous take, real `tmux send-keys` throughout, no scripted/injected
props:

1. Composer starts empty at 120×40 (`COMPOSER_AUTOFILL_DELAY_MS=120000`
   so the unattended fallback can't preempt real typing).
2. Real character-by-character typing (`hello real keys`), 5 real
   `BSpace` presses removing exactly 5 characters
   (`captures/limits-push-frame-typing.png` shows the mid-typing state,
   caught with a partial word), `Escape` to clear, then the real fixture
   message typed and submitted with `Enter` — moves into `Static`
   scrollback immediately after submission
   (`captures/limits-push-frame-static-scrollback.png`).
3. Live resize mid-flow: `tmux resize-window` to 90×34 while the
   permission prompt's countdown is live — header and permission panel
   visibly reflow in the same frame the countdown continues in.
4. A second live resize to 60×30 —
   `captures/limits-push-frame-resized-60x30.png` shows the header
   reading `60×30`, the permission-denied result panel, and the
   composer's now-two-line wrapped text, all at the narrower width,
   with `Tasks 3/3` and `idle` status confirming the session ran to
   completion.
5. The countdown won the race against my keypress this take (auto-deny
   fired a beat before my `1` landed) — this round captured the
   auto-deny branch rather than the approve branch. Round 4's captures
   already cover the approve branch
   (`captures/full-shell-frame-tests-passed.png`,
   `captures/screen1-autodeny-fix.gif` covers deny), so this is not a
   gap in what's on record overall, just which branch this particular
   take landed on.

### Honest final take, after two rounds of pushing this library to its real limits

`@ai-sdk/tui`'s own contribution to this evaluation topped out after
round 2 (it's a thin `runAgentTUI(options)` wrapper — permission +
diff-view screens, nothing else in its public API, re-confirmed this
round by re-reading its `.d.ts`). Everything since round 3 has been pure
Ink engineering *around* that thin wrapper, using Ink's lower-level
primitives (`Static`, `useInput`, `useStdout`) to reconstruct the pieces
a real terminal coding-agent UI needs that the library itself doesn't
provide: persistent scrollback that stops repainting once settled, a
genuinely interactive text composer, and live-reflowing layout on
terminal resize. All three of those are now real and independently
re-verified in this round, not just claimed — and all three are
Ink-level capabilities, unrelated to anything `@ai-sdk/tui` itself
supplies.

That is the honest ceiling: this prototype gets visually and
mechanically close to a genuine Claude-Code-style terminal experience —
close enough that, watched live, the settle-into-scrollback behavior,
real backspace-capable typing, and live resize reflow are difficult to
tell apart from the real thing in short clips. But `@ai-sdk/tui` gets no
credit for any of round 3 through 6's work; it supplied two screens'
worth of scaffolding and nothing since. If the goal is "evaluate
`@ai-sdk/tui`," the verdict was already final after round 2. If the goal
was "how close can Ink itself get to a Claude-Code-shaped terminal UI,"
this round's answer is: close, on the specific dimensions tested here,
with the caveat that a from-scratch reimplementation of an agent
transport, multi-line editing, real streaming markdown rendering, and
much more of Claude Code's actual surface area was never in scope and
remains untested. And separately, this round surfaced that the
*recording tooling* (`asciinema --window-size`) has its own real
limitation unrelated to Ink or the library — worth remembering for
whoever records the next one.
