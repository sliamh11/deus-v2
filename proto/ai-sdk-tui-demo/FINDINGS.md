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
