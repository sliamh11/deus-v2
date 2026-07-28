# LIA-496 — Production-fidelity UI spike: "Reading Room" (web) + "Transcript" (Ink): FINDINGS

Question this spike answers: pushed well past LIA-495's deliberately minimal
fixture scope (one tool call, one permission prompt, one diff), does the
shared-runtime/thin-UI-layer pattern still hold up when the two targets are
allowed — encouraged, even — to look **genuinely different**: a warm-light
editorial "Reading Room" on the web and an amber-phosphor terminal
"Transcript" on Ink, both built to full ChatGPT/Claude-web-grade feature
depth (sidebar, streaming, markdown+syntax highlighting, permissions with a
real grant store, diffs, branching, responsive/keyboard nav, error states) —
not just structurally similar, but visually unrelated on purpose?

Both prototypes live under this worktree's `proto/`:

- `proto/shared/` (`@lia496/shared`) — a real npm-workspace package, not
  LIA-495's duplicate-and-diff. 14 source modules: `adapter.ts`,
  `threadList.tsx`, `history.ts`, `permissions.ts`, `status.ts`,
  `highlight.ts`, `diffStatus.ts`, `util.ts`, `virtualFs.ts`,
  `fixtures/{threads,conversations}.ts`, plus two smaller reactive-state
  trackers added during the review-fix round (`listStatus.ts` on the web
  side's needs, `freshDraftTracker.ts` for Ink — see § 3). Dependencies:
  `@assistant-ui/core`, `assistant-stream`, `shiki` only — no
  `@assistant-ui/react`, no `react-ink`, no `react-dom`.
- `proto/web-app/` — "Reading Room": Vite + React 19 + `@assistant-ui/react`
  + `@assistant-ui/react-markdown`. 14 source files (11 named components +
  `main.tsx`/`App.tsx`/`statusColor.ts`).
- `proto/ink-app/` — "Transcript": `@assistant-ui/react-ink@^0.0.35` +
  `ink@^6` + `react@^19`. 15 source files (10 named components + `main.tsx`/
  `App.tsx`/`theme.ts` + the two review-round additions,
  `freshDraftTracker.ts` and the OSC-52 copy pair
  `codeClipboard.ts`/`CodeCopyHotkey.tsx`).

## 1. What was built

**Shared runtime (`shared/`).** The full `RemoteThreadListAdapter` contract
(`FixtureThreadListAdapter` in `threadList.tsx`) — real `list`/`rename`/
`archive`/`unarchive`/`delete`/`initialize`/`fetch`, plus a `generateTitle`
bridge (`createSimpleTitleAdapter`'s string wrapped into an
`AssistantStream` via `createAssistantStream`/`appendText`, the exact
signature `RemoteThreadListAdapter.generateTitle` requires — this was
identified and corrected across three rounds during planning itself, before
any code existed). Per-thread `ThreadHistoryAdapter` isolation. A new
session-scoped permission **grant store** (`permissions.ts`) that closes
LIA-495's honest "Always allow didn't persist" gap — proven live on both
targets, not just unit-tested (§ 2). `highlight.ts` owns a single
`getSingletonHighlighter` instance, pre-warmed via a top-level `await` in
the shared module itself (both targets' themes loaded once, before either
app renders its first frame) so `codeToHtml`/`codeToTokens` calls at
runtime are synchronous — the frozen `expected` for every code-block row is
"highlighted from the first frame," and both targets' VERIFICATION.md rows
confirm exactly that, not a race.

**Web ("Reading Room").** All 11 named components wired per the plan's
"consuming call sites" section: `AssistantRuntimeProvider(
useRemoteThreadListRuntime(...))` → `Sidebar` + `Thread`/`Composer`;
`MarkdownText` → `CodeBlock` for fenced blocks (shiki + clipboard copy);
`DiffPanel` for the `Edit` tool; `PermissionCard` for `delete_file`;
`ActionBar`/`BranchPicker` on the message footer; `EmptyState`/`ErrorState`
for the two terminal states. Porcelain green-gray ground, deep pine accent,
serif assistant prose in a ~44rem column, dark inset diff/code cards, pill
composer — the literal `theme.css` token values from the taste-pass design
source, copied durably into the worktree at `proto/design-source/
taste-pass-fable.html`.

**Ink ("Transcript").** All 10 named components, same call-site shape,
verified on real `tmux`-pty renders rather than JSX inspection alone:
amber `❯` / dim `●` gutter glyphs, dashed `[y]/[a]/[n]` permission box,
`> ` composer prompt, the real `DiffView` primitive (no duplicate header —
LIA-495's proven fix carried forward), `TokenLine.tsx` walking
`codeToTokens()`'s per-token hex color into `<Text color>` (fontStyle
dropped, an accepted, explicitly-named fidelity loss for Ink). Two
components were added beyond the plan's original 10 during the review-fix
round to close a Must-tier gap the build stage had silently dropped:
`codeClipboard.ts` + `CodeCopyHotkey.tsx` implement the OSC-52
best-effort terminal clipboard copy the plan's feature bar actually
required.

## 2. Shared-runtime purity

`scripts/check-shared-purity.sh` — greps `shared/src` for
`@assistant-ui/react`, `react-ink`, `react-dom`, `var(--`, hex literals,
CSS named colors, `rgb(`/`hsl(`, raw ANSI SGR escapes, and `chalk`
(exemptions scoped to `fixtures/`, where scripted conversation *data* can
legitimately mention a color word as inert text). Re-run fresh at this S5
reconcile stage, not trusted from an earlier report:

```
$ bash scripts/check-shared-purity.sh
check-shared-purity: PASSED — shared/src is clean.
```

**No `check-shared-parity.sh` exists and none was needed.** The plan's
fallback path (per-app duplicate copies + a `diff -rq` parity gate,
degrading to exactly LIA-495's already-proven pattern) only triggers if the
single-shared-package dedupe fails. It didn't: `SETUP-NOTES.md` records
`npm ls @assistant-ui/core` / `npm ls assistant-cloud` both resolving to one
hoisted version each (`0.3.0` / `0.1.37`) across `web-app`, `ink-app`, and
`shared` itself — confirmed directly, not asserted — because S0 pinned
`@assistant-ui/react-ink@^0.0.35` (not LIA-495's `0.0.33`) specifically to
match `@assistant-ui/react@0.15.0`'s own `@assistant-ui/core`/
`@assistant-ui/store` version pins. `shared/scripts/verify-headless.ts`'s
40/40 assertions (adapter streaming shape, grant-store suppression proven
in both directions, per-thread history isolation, thread-list CRUD) stayed
green throughout every build/review round.

## 3. Verification results (real capture, not retrofitted)

Both targets' `expected` columns were frozen at plan time from the
taste-pass design source, before implementation — not authored after the
code existed to describe what shipped (the exact anti-pattern this repo's
`visual-verification-required` gate exists to catch).

**Web ("Reading Room") — 19 PASS / 1 FAIL**, real Playwright against a live
`vite` dev server, screenshots + a full-session webm at
`web-app/captures/verify/`. The one FAIL is a real, honestly-disclosed
product gap, not a test artifact: **no UI path invokes `composer.beginEdit()`
on a user message**, so "edit a user message → branch picker shows 2/2" is
unreachable — confirmed by reading `Thread.tsx`'s `UserMessage` directly
(renders only a static chip, no button/dblclick handler) and by a real
double-click producing native text selection, not an editable field, with
`.s-branchpicker` count staying at 0. Critically, this is scoped narrowly:
the **branching mechanism itself is proven working** via the independent
Regenerate/Reload test, which produced a genuine second variant and a
correctly-rendered "2 / 2" `BranchPicker` — so the gap is "no edit
affordance," not "branching is broken." `BranchPicker.tsx`'s header comment,
which previously claimed the edit affordance existed, was corrected to
describe only the proven path.

**Ink ("Transcript") — 14 PASS / 0 FAIL**, real `tmux` + `asciinema`
recordings driven by genuine `tmux send-keys -l`, gif via `agg`, stills via
Python `PIL.Image.seek()` (ffmpeg remains broken on this host, consistent
with LIA-495). Zero FAILs *in the current VERIFICATION.md* is the
post-review-fix state — two real defects were caught and closed during the
review round (§ 4), not hidden.

Both counts are the **current, post-fix** state of `VERIFICATION.md` in
this worktree, independently re-derived from the file at this reconcile
stage (not copied from an intermediate report) — earlier in the pipeline
the Ink capture stage had recorded 10 PASS / 2 FAIL and the web capture
stage 16 PASS / 1 FAIL against pre-fix code; those numbers are superseded
by the REVISE-round re-capture described in `VERIFICATION.md`'s own header
and § 4 below.

## 4. Review round — what it caught

One review round (fresh Fable-model dispatch, per the plan's model
assignment), full-diff + artifact review against the real worktree state.
Verdict: **REVISE**, then **SHIP** after fixes, re-verified independently
at this S5 stage rather than trusted from the fix agent's own report (spot
checks below).

Findings from the round, and their disposition:

- **High — grant-store proof was a false PASS.** The original
  `verify-s3.mjs` clicked "Allow once" (never "Always allow") and never
  actually sent a third user message, so `turn3Start` never ran — the pass
  condition was vacuously true regardless of whether the grant store
  worked. Fixed: the script now clicks **Always allow** at turn 1, sends a
  genuine third message, and asserts both that no new permission card
  renders *and* that the narration text names the auto-approval. Surfaced
  a second real bug along the way — `ActionBar.tsx`'s `autohide="not-last"`
  unmounts (not CSS-hides) the Reload button between turns, so a naive
  `waitFor({state:"visible"})` after turn 1 resolves on a stale element and
  silently drops the next submit; fixed with a 1→0→1 count-cycle wait.
- **High/Medium — Ink sidebar had two real bugs, not one.** (1)
  `ThreadListPrimitive.Root` renders a plain `<Box>` with no
  `flexDirection`, defaulting to Ink's row-layout and merging "+ new
  session" onto the same terminal line as "── today"; fixed with an
  explicit `flexDirection="column"`. (2) Day-bucket header math read
  `Object.values(threadItems)` (insertion order) while
  `ThreadListPrimitive.Items` actually iterates the separate `threadIds`
  array — the two only agreed right after a fresh launch, then diverged
  once real interaction reordered threads, misfiling a thread under the
  wrong day header. Fixed by mapping `threadIds` to its own items, matching
  `.Items`'s real index space by construction.
- **Medium — OSC-52 clipboard copy on Ink was Must-tier scope, silently
  dropped.** No implementation, no VERIFICATION.md row. Implemented this
  round (`codeClipboard.ts` + `CodeCopyHotkey.tsx` + a `ctrl+y` binding),
  verified two ways: a raw-pty capture confirmed the actual OSC-52 escape
  bytes, base64-decoded back to the real rendered code text (not a
  placeholder); a live UI indicator confirmed the "copied" state renders.
- **Medium — web sidebar loading/error states were unimplemented, and the
  empty-state message rendered *wrongly* during the loading window** (worse
  than simply missing — `isEmpty` was true both before and after a real
  `list()` resolved, so users would briefly see "No threads yet" during a
  genuine load). Fixed with an owned `listStatus.ts` tracker (`list()`
  itself has no reactive error field on `@assistant-ui/core`'s
  `ThreadsState`, confirmed by reading `RemoteThreadListThreadListRuntimeCore.tsx`
  directly — this state was previously not just missing but unobservable).
- **Low — `PermissionPrompt.tsx`'s `useInput` violated Rules of Hooks**,
  called conditionally after an early return; latent (never crashed in this
  fixture's scripted flow, since no single component instance ever
  transitions from no-approval to has-approval across renders) but a real
  defect independent of whether lint happened to catch it — ink-app has no
  `.oxlintrc.json` (web-app does), so nothing local was enforcing
  `react/rules-of-hooks` there. Fixed: the hook is now called
  unconditionally before either return branch. **Spot-checked directly at
  this S5 stage** (not trusted from the fix report): read
  `PermissionPrompt.tsx` lines 79–106 — `useInput` is hoisted above both
  the `!approval` and `resolved` early-return branches, with `isActive`
  correctly accounting for the no-approval case.
- **Low — `ctrl+n` (new-session empty state) didn't rebind the message
  pane.** Root-caused to a genuine `@assistant-ui/store` staleness: the
  singular `s.thread` scope everything `ThreadPrimitive.Empty`/`.Messages`
  reads is built on `Derived()`+`useClientResource()`, which can return a
  prior thread's `ThreadState` on specific rapid `switchToNewThread()`
  sequences (`s.threads.mainThreadId`, a sibling non-`Derived` scope,
  stayed correct throughout every reproduction — confirming the bug is
  narrowly in the derived-state layer, not thread-list bookkeeping
  itself). Two upstream patches were tried and disproven live before
  landing on the actual fix: `Sidebar.tsx`'s own bookkeeping now marks a
  thread "fresh" the instant `switchToNewThread()` resolves, and
  `App.tsx`'s `MainPane` renders `EmptyState` directly for a fresh id,
  bypassing the unreliable primitives entirely. **The single-`ctrl+n` case
  (the actual finding) is fixed and re-captured** (`ink-app/captures/verify/
  19–21`, `24`). **Spot-checked directly at this S5 stage**: read
  `App.tsx` lines 109–134 — `MainPane` derives `isFreshDraft` from
  `Sidebar.tsx`'s own tracker, not `s.thread`, exactly as described.
  **Known residual defect, honestly kept in `VERIFICATION.md` and this
  file rather than hidden**: two rapid `switchToNewThread()` calls in one
  session can still bleed the first draft's content into the second after
  submit — reproduced 3+ times live, not resolved by this fix, out of
  scope for this pass.
- **Low — `BranchPicker.tsx`'s header comment claimed a nonexistent
  affordance.** Corrected to describe only the real, proven Reload-driven
  branching path (see § 3's web FAIL row for the underlying gap). **Spot-
  checked directly**: read the corrected comment (`BranchPicker.tsx` lines
  11–19) — it now explicitly documents that no button/dblclick handler
  calls `composer.beginEdit()`, matching the FAIL row's own language.

All fixes independently re-verified at this S5 stage against the live file
content (not re-asserted from the fix agent's report): the two ink-app
fixes above were read directly and match their described mechanism exactly.
`check-shared-purity.sh` re-run clean (§ 2). `VERIFICATION.md`'s post-fix
counts (§ 3) were independently re-derived from the file, not copied
forward.

## 5. Overall assessment — does "genuinely divergent designs on a shared runtime" hold up?

**Yes, and more convincingly than LIA-495's minimal-scope version did** —
this spike deliberately stress-tested the pattern at much higher UI depth
and, crucially, let the two targets diverge *visually* on purpose rather
than mirroring each other's structure, and the shared layer still held.

**What held up well:**
- The `shared/` package stayed genuinely free of presentation values
  end-to-end — not just at S1 handoff but through an entire review-fix
  round that touched both targets' runtime-adjacent code
  (`listStatus.ts`, `freshDraftTracker.ts`) without either file needing a
  CSS string, a hex literal, or a target import to do its job. The purity
  gate had real teeth: it caught the *builders' own explanatory comments*
  quoting forbidden substrings as examples, not just accidental
  presentation leakage — a stricter self-check than LIA-495 exercised.
- The `RemoteThreadListAdapter`/history/grant-store contract — arguably the
  most complex shared surface in this spike, well beyond LIA-495's fixture
  scope — is implemented exactly once in `shared/threadList.tsx` and
  consumed identically by both targets' `useRemoteThreadListRuntime` call.
  The grant-store proof (turn 3's second permission-requiring action
  producing zero prompt UI) is independently verified live on **both**
  targets, not asserted once and assumed to transfer.
- `highlight.ts`'s single pre-warmed shiki singleton is consumed by
  fundamentally different renderers per target (`codeToHtml` producing a
  DOM string vs. `codeToTokens` walked into Ink `<Text>` elements) with
  zero theme-name leakage into the shared file — the exact discipline
  LIA-495's own `tokens.ts` finding recommended for a real migration, now
  proven to hold under actual pressure rather than just recommended in
  the abstract.

**Where it genuinely strained, honestly:**
- Ink's `App.tsx`/`Sidebar.tsx` needed real, non-trivial workaround code
  (`freshDraftTracker.ts`) to route around an upstream
  `@assistant-ui/store` reactive-staleness bug that the web target never
  hit at all — this is a genuine cross-target asymmetry, not a shared-layer
  problem, but it means "the same primitives behave identically on both
  targets" does **not** fully hold at this depth; Ink's remote-thread-list
  primitives have a real, reproducible edge case web's DOM-based
  equivalents don't share. The residual two-draft-bleed defect is the
  visible cost of that asymmetry remaining unresolved.
- Two of the higher-severity review findings (the false-PASS grant-store
  test, the Ink sidebar line-merge/header bugs) were caught only by an
  actual review pass reading real running output, not by either target's
  own build-stage self-report — both build stages had claimed these
  exact features "confirmed live." That's the second spike in a row
  (LIA-495 found 5 similar defects) where a stage's own "verified" claim
  did not hold under independent review, which is a data point about this
  workflow's own review-gate necessity, not about the shared-runtime
  pattern specifically.
- One Must-tier feature (Ink's OSC-52 copy) was silently dropped by the
  build stage entirely, with no VERIFICATION.md row flagging the gap —
  caught only because the review pass checked the plan's feature-scope
  section against the delivered code, not because any build-time signal
  surfaced it.

**Recommendation:** the shared-runtime/thin-UI-layer split is a strong
pattern to build on for a real migration, including at production-grade UI
depth and even when the two targets are intentionally styled unalike — but
"build once, migrate the UI layer" undersells the actual risk surface
slightly: budget real time for target-specific primitive quirks (Ink's
reactive-state staleness here; LIA-495's missing `DiffView`/checklist
primitives on web previously) as a first-class category of finding, not an
edge case, and keep an independent review pass in the loop even when each
build stage's own live-testing claims are thorough — both this spike and
LIA-495 show that self-reported "verified live" is not a substitute for a
separate reviewer actually reading the resulting artifacts.
