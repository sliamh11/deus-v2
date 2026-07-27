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

## Discrepancies found during reconcile verification

None. Every claim in both agents' self-reports (file paths, artifact paths,
LOC counts, source-line citations for the approval-primitive finding,
presence of the `assertNoFalsePositiveCheckmark` guard, GIF dimensions/
format) was independently confirmed against the actual files on disk and
against `node_modules/@ai-sdk/tui`'s real source before being written into
this document.
