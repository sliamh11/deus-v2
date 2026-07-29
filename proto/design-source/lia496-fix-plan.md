# LIA-496 Review-Fix Plan — Reading Room (web) + Transcript (Ink)

## Context

The prior LIA-496 build (production-fidelity spike, both platforms) is done, pushed as draft
PR #78 (the `deus-v2` repo). Following that, the user asked for a UX/UI concept review against
real reference products (ChatGPT/Claude.ai for web; Claude Code/Codex CLI/Hermes for Ink),
executed via a dedicated Workflow with two independent reviewers (Fable + GPT-5.6-Sol) per
platform, cross-validated through synthesis. That review is complete and published (both
platforms now cross-validated, including a real correctness bug GPT's second pass caught that
Fable's had missed — thread history mis-bucketed by time).

The user's new instruction: **fix every finding from both platforms' reviews**, and — this is the
part that changes execution shape, not just scope — **see genuine visual proof at multiple
checkpoints throughout the work, not one reveal at the end.**

This plan was drafted by a Fable-model `planner` agent dispatch (per this thread's standing model
assignment: Fable plans, Opus 5 reviews the plan, Fable code-reviews each batch), which read the
full raw review data (not a summary), read the actual source files on both targets, and — for the
single highest-risk architectural claim — verified the mechanism directly against
`node_modules/ink/build/ink.js` before committing the plan to it, rather than assuming the
reviewers' recommendation would just work.

Intended outcome: every finding fixed, real (not fabricated) verification evidence per batch, and
a cumulative visual artifact the user can watch build up across the whole effort.

## Source-of-truth note on the finding lists

Two workflow runs exist per platform in the review journal (`wf_2da1c91c-bb7`); the published
artifact (the review job's HTML output, job id `d4c546e7`) is the final
merged state and is authoritative — it includes GPT-web findings (time-bucket bug, always-allow
scope, focus-trap detail, empty-state CSS bug) that only surfaced on the third gpt-web retry and
don't appear in the journal's synthesis entries. The inventory below is the union of the HTML's
final findings and the latest journal syntheses. Nothing from either review is dropped.

**Severity source of truth (noted during plan-review):** where this plan's stated severity differs
from the published HTML's badge (a few items were relabeled while drafting, e.g. I14/W5 shown as
high here vs. medium in the HTML; W16 shown as medium here vs. High/Low split between the two
individual reviewers), **the HTML's merged badge governs** — this plan's inline severity words are
descriptive framing, not a re-scoring. Harmless to execution since all findings ship regardless of
label, but batch dispatches should defer to the HTML if a severity label ever needs to drive a
real prioritization decision (e.g. which finding to spot-check first under time pressure).

## Three reviewer disagreements — resolved

### D1 — Ink permission prompt: approval control replaces the composer row entirely

Fable praised the current design (composer swaps to a "resolve above" notice while the dashed
approval box shows) as better than leaving a live input mounted. GPT called the same behavior a
duplication defect and wanted the approval control to fully replace the composer.

**Decision: remove the notice row; while an approval is pending, the dashed approval box is the
sole bottom-region interactive surface.** Both reviewers' real concerns are satisfied: Fable's
value (no live input mounted) is preserved — full replacement also unmounts the live input; GPT's
objection (two surfaces both talking about the same pending decision) is resolved by removing the
duplication. Reference check: Claude Code's permission dialog occupies the input slot itself, never
renders a second disabled line beneath it; Hermes' approval panel does the same. The "why is typing
dead" context the notice carried moves into the approval box's own new hint row (needed anyway for
the esc/default-option fix, I14). Deliberate platform asymmetry: web keeps the composer mounted-but-
disabled during approval (W14) because ChatGPT/Claude.ai's convention is a persistent composer,
while Ink follows Claude Code/Hermes' slot-replacement convention — same underlying principle
(match the reference products), opposite surface outcomes per platform.

### D2 — Ink diff gutter: keep single-column (reject GPT's two-sided ask)

Claude Code's actual convention is a unified diff with a single gutter — two-sided old/new gutters
are a split-view/GitHub convention, not what either named CLI reference does. At the newly-adopted
terminal-responsive width, a second number column spends columns in the exact pass where the
surrounding box is being removed specifically to reclaim width.

**Corrected during plan-review — the original two follow-on deliverables aren't achievable through
`DiffView`'s real API and must be replaced.** Verified directly against
`node_modules/@assistant-ui/react-ink/dist/primitives/diff/DiffView.d.ts` (hoisted to the workspace
root, not each app's own `node_modules`): its full prop surface is `{patch, oldFile, newFile,
showLineNumbers?: boolean, contextLines?, maxLines?}` — no truncation-count output at all, and
`showLineNumbers` is a bare boolean, not a per-row-class toggle. Concretely:
- The "explicit '… +N lines hidden · ctrl+o expand' affordance" is **not implementable through
  `DiffView` as specified** — there is no `N` to read from the primitive. IB2's dispatch computes
  `N` itself from the raw patch (count of hidden lines = total patch lines minus `maxLines`) and
  renders the affordance as a sibling row outside `DiffView`, not as a prop into it.
  - The ctrl+o **expand** behavior itself has no primitive support either — `maxLines` is a static
    cap with no toggle. IB2 owns this as local component state (`expanded: boolean` toggling the
    `maxLines` value passed to `DiffView` between the capped number and `undefined`), not a
    library feature.
- "Number only context/`+` rows on ambiguous deletions" — **not implementable**, `showLineNumbers`
  has no such granularity. Dropped as a fallback; if `DiffView`'s own numbering is confirmed
  ambiguous around deletions during IB2 (verify this first, don't assume), the fix is either
  accepting Claude Code's own actual convention (which also just numbers the unified view, no
  special-casing) or filing it as a known gap — not inventing an unsupported prop.

### D3 — Web composer secondary row: build the structural row with exactly one real control

Fable rated the missing attach/model-picker row "low, acceptable for a spike"; GPT rated it "high,
a real structural gap." Resolution: build a genuinely interactive model-picker dropdown (real
`<button aria-haspopup="listbox">`, real popover, arrow-key + Escape + click-outside handling)
toggling between two scripted labels ("Sonnet 5" default, one alternate). This is web-app-local
presentation state — explicitly NOT in `shared/`, not fixture data, a code comment states it's a
UI-structure demo. Do **not** build an attach button — an attach control that can't attach is
exactly the "visibly actionable but actually disabled" fake affordance the Ink review already
condemned (`+ new session`); a code comment reserves the pill's left-gutter slot and states why
it's empty. This also fixes Fable's separate "static badge styled as interactive" finding — the
current inert `<span className="s-model">` (`Thread.tsx:80`) becomes the real dropdown trigger.
Lands as medium severity: the structural row is real and built, a full attach/tools tray is
explicitly out of scope as dishonest for a fixture spike.

## The gating architectural decision — Ink scrollback model

Both reviewers converge on recommending Claude Code's inline/native-scrollback model over a full
alternate-screen app. This plan verified the mechanism directly rather than assuming it:

- `ink.js:320-327` (read directly): once dynamic output height ≥ `stdout.rows`, every subsequent
  render writes `ansiEscapes.clearTerminal` = `\x1B[2J\x1B[3J\x1B[H` — CSI 3J, the destructive
  saved-scrollback clear GPT's live capture caught. The current app makes this inevitable because
  the *entire* 104-col frame including all messages is dynamic output.
- `<Static>` (a real Ink 6 export, confirmed in `build/index.d.ts`) writes its output exactly once
  into native scrollback (`ink.js:337-349`); the destructive clear path never fires as long as the
  *dynamic* region stays under terminal height. Fable's prescription — completed turns flow into
  `<Static>`, the dynamic tail is only the in-flight message + status + composer — is genuinely
  achievable. This is Claude Code's actual model.

**Constraints this forces, stated up front so they aren't discovered mid-batch:**
1. `<Static>` items are immutable and append-only. Thread switching therefore *appends* (a
   `── thread: <title> ──` banner + that thread's committed turns as new keyed items into one
   ever-growing app-level committed-blocks array) — prior threads' output stays in scrollback
   above, exactly like Claude Code `/resume`. Never replace or shorten the items array.
2. A single in-flight message taller than the terminal would still trip the clear path once.
   Mitigation: commit at **part** granularity — each completed text/tool part of the streaming
   message moves into `<Static>` as it completes; only the actively-streaming part + status row +
   composer stay dynamic.
3. `ThreadPrimitive.Messages` cannot render inside `<Static>` (its items-callback model doesn't fit
   Static's contract). **This is the single riskiest piece of the whole plan.**

   **Design section, added during plan-review — two candidate approaches, both must be spiked
   before committing:**
   - **Approach A (prop reconstruction):** the committed renderer reads plain completed-message
     snapshot data and reuses the existing leaf components (`MarkdownText`, `BashLine`,
     `DiffPanel`, `PermissionPrompt`'s resolved-line) by constructing their props explicitly.
   - **Approach B (by-index provider), verified available and not previously evaluated:**
     `MessageByIndexProvider` and `unstable_useThreadMessageIds` are real exports
     (`@assistant-ui/core/react`, re-exported from `@assistant-ui/react-ink`'s `dist/index.d.ts`).
     Because `<Static>` renders each child once and then drops it from `itemsToRender`
     (`components/Static.js`: `items.slice(index)` + index only ever advances), wrapping the
     **existing** `UserMessage`/`AssistantMessage` components in a `MessageByIndexProvider` per
     committed message index gives the same one-shot, inert-snapshot semantics as Approach A —
     without hand-reconstructing every leaf component's props from scratch. If it works, it's less
     code and less drift risk (leaf components stay driven by the real runtime shape, not a
     parallel hand-typed snapshot type).
   - **IB1's spike must build both against one real multi-part message (text + tool call +
     permission) and record which one actually renders correctly inside `<Static>` with zero
     console errors and zero visual diff from the equivalent live-rendered message.** Whichever
     wins, use it for the rest of IB1; if only one compiles/renders cleanly, that decides it — no
     need to force a tie-break.
   - **Spike PASS criterion, stated explicitly (plan-review Q1):** the spike PASSES when at least
     one approach renders a real multi-part committed message inside `<Static>`, confirmed via
     `tmux capture-pane` showing correct text/tool/permission content with zero runtime errors in
     the process's stderr log, AND the scrollback-preservation proof (below) holds for that render.
   - **On FAIL (neither approach renders cleanly):** stop IB1 before building the rest of the
     batch on it. Do not silently fall back to a third improvised approach — surface the concrete
     failure (which approach, what broke) back to the orchestrating session before continuing, since
     every later batch depends on IB1 landing. This is a real stop condition, not a formality.
4. This decision **forces the sidebar decision into the same batch**: a persistent 34-column rail
   is geometrically impossible once transcript lines are printed into scrollback. IB1 is
   deliberately the one large architectural batch for exactly this reason.
5. **Resize subscription (plan-review Q2):** `useStdout()` is a bare context read with no resize
   subscription of its own (`ink/build/hooks/use-stdout.js`) — I4's "resize-subscribed" claim needs
   a real mechanism, not just calling the hook once. Use a manual `stdout.on('resize', ...)`
   listener (Node's own TTY resize event) inside a `useEffect`, updating local state that drives
   the frame width, cleaned up on unmount. Confirm `process.stdout.columns` updates live under this
   listener during IB1's resize-demo capture (80 → 120 columns) before treating I4 as done.

One more resolved item: Ink composer border stays as the current top-hairline (Fable) — GPT's
"docked web panel" read is largely produced by the enclosing root frame, which IB1 deletes; if the
hairline still reads web-ish once the frame is gone, that's a cheap one-line follow-up, re-evaluated
against IB3's real capture rather than pre-committed now.

## Full fix inventory

### Reading Room (web) — 18 items, by theme

**A — Run-state:** W1 stop-generating control (`Composer.tsx`, swap send circle for
`ComposerPrimitive.Cancel` while running, high); W2 streaming activity indicator (`Thread.tsx`,
`MarkdownText.tsx`, stream-head cursor + pre-first-token shimmer — **corrected during plan-review**:
`useStreamingTiming`/`StreamingTimingState` are real exports of `@assistant-ui/core/dist/react/
index.d.ts:114`, use that hook to drive the shimmer/cursor timing instead of hand-rolling a timer,
medium); W3 scroll-to-bottom (`Thread.tsx`, `ThreadPrimitive.ScrollToBottom` — **confirmed real**
during plan-review, `primitives/thread/ThreadScrollToBottom.d.ts`, no fallback needed, medium); W4
error card inline retry (`ErrorState.tsx`, low).

**B — Sidebar & navigation:** W5 always-armed delete/no overflow menu/hover reflow
(`Sidebar.tsx`, `theme.css`, hover `…` menu with confirm on delete, reserved-width slot, high); W6
**real correctness bug** — every non-today thread bucketed as "Yesterday" (`Sidebar.tsx:34-57`,
truthful Today/Yesterday/Previous 7 days/Older buckets, high); W7 no desktop sidebar collapse
(`App.tsx`, `Sidebar.tsx`, `Thread.tsx`, `theme.css`, generalize the existing sub-860px drawer
transform, low-medium); W8 no sidebar search (`Sidebar.tsx`, client-side title filter, medium); W9
mobile drawer doesn't close on selection + real focus-trap gap (`Sidebar.tsx`, `App.tsx`, call
`onCloseDrawer` on activation, trap focus + `inert` background while open, high).

**C — Message affordances:** W10 no edit-to-branch/copy on user messages (`Thread.tsx`, hover
pencil wired to `composer.beginEdit()` — confirm the runtime API name before wiring — + copy, high);
W11 branch arrows have no accessible name (`BranchPicker.tsx`, `aria-label`, low); W12 reasoning
always-expanded unlabeled (`Thread.tsx`, `theme.css`, collapsed-by-default disclosure, medium); W13
tool calls dump raw output with no disclosure grammar, diff card has no copy/collapse
(`Thread.tsx`, `DiffPanel.tsx`, collapsed row + chevron, medium).

**D — Composer, permissions, empty state:** W14 composer unmounts during pending approval
(`Composer.tsx:26-32`, keep mounted, disable textarea with waiting placeholder, low-medium); W15
"Always allow" doesn't state scope (`PermissionCard.tsx`, "Always allow (this session)" + scope
note, high); W16 composer secondary row per D3 (`Composer.tsx`, `Thread.tsx:80`, medium); W17
empty state exposes internal fixture language + real CSS centering bug + dead space
(`EmptyState.tsx:20`, `theme.css`, remove fixture-spike copy, fix flex-parent height, dock composer
under greeting, medium); W18 multiline pill geometry (`theme.css`, relax radius + `flex-end` at
multiline heights, low).

### Transcript (Ink) — 16 items, by theme

**E — Terminal-native canvas (architectural):** I1 painted truecolor background
(`App.tsx:166`, `Sidebar.tsx:212`, remove entirely except inverse cursor row/key-cap chips, high);
I2 destructive scrollback clear / no scrollback model (`App.tsx`, new committed-blocks module,
`Messages.tsx`, `<Static>` model per the verified decision above, high); I3 persistent sidebar is
the wrong pattern (`Sidebar.tsx` → new `ThreadPicker.tsx`, transient ctrl+t/`/threads` overlay,
real "n: new session" binding, high). **Consuming call site, added during round-2 plan-review**
(this is a brand-new rendering component and no batch previously named a visual artifact for it —
the exact gap `visual-verification-required` exists to catch): `ThreadPicker.tsx` is mounted from
`App.tsx`, toggled by the ctrl+t/`/threads` binding, rendered as an overlay in the dynamic tail
region above the composer. IB1's capture list (below) must include a dedicated asciinema recording
showing: ctrl+t opening the picker, arrow-key navigation between at least two threads, `n`
triggering new-session creation, and the picker closing on selection/esc — not just implied by I2's
"frame gone" capture. I4 hardcoded `width={104}` breaks both directions
(`App.tsx:166`, `useStdout().stdout.columns` + manual `stdout.on('resize', ...)` listener per the
constraint above, high); I5 boxed header + sidebar footer duplicate identity (`App.tsx:167-182`,
`Sidebar.tsx:260-263`, identity banner printed once into `<Static>`, one compact status line near
composer, medium). **Corrected during plan-review — public-repo generic-value fix, blocking:**
the `deus-v2` repo is confirmed **public** (`gh repo view --json isPrivate` → `false`), and
`Sidebar.tsx:261-262` currently hardcodes a personal username and home-directory path into the sidebar
footer — I5's once-printed identity banner must NOT carry this personal value forward. Replace with
`os.userInfo().username` (or a generic placeholder like `"you"`) and `process.cwd()`'s basename (or
simply the literal string `"~"`), matching the "public repo changes must be user-agnostic" rule
already in this repo's core-behavioral-rules.md — this is the exact spike-scoped moment to fix it,
not defer.

**F — Content grammar:** I6 unbounded tool output (`Messages.tsx:42-67`, cap ~5 lines + a
locally-computed "… +N lines · ctrl+o expand" row (same pattern as D2's corrected diff-cap
approach — `N` computed from the raw result, not read from a library prop), auto-expand errors,
high); I7 glyph collision ⏺ vs ●
(`Messages.tsx:40`, `DiffPanel.tsx:20`, `PermissionPrompt.tsx:43`, `theme.ts:37`, one status-colored
glyph for tools, low); I8 redundant "you"/"deus" speaker labels (`Messages.tsx:93,109`, drop —
gutter glyphs already encode speaker, low); I9 over-boxing — thinking box, code-block boxes, diff
box, nested borders (`Messages.tsx:78`, `TokenLine.tsx:73`, `DiffPanel.tsx:57`, unbox, borders
reserved for composer/permission/overlays, medium); I10 diff panel box/gutter/silent cap per D2
(`DiffPanel.tsx`, medium).

**G — Run-state, input, discoverability:** I11 no spinner/elapsed/interrupt — **corrected during
plan-review**: `@assistant-ui/react-ink` already ships real primitives for this
(`primitives/loading/index.d.ts`: `LoadingPrimitive.Root/Spinner/Text/ElapsedTime`; also
`primitives/statusBar.d.ts`: `StatusBarPrimitive.Root/ModelName/MessageCount/TokenCount/Latency/
Status`) — compose these into the dynamic status row instead of hand-rolling a new `StatusRow.tsx`
from scratch; only the esc-cancel wiring and the row's exact field selection are custom, medium;
I12 shortcuts
undiscoverable, fake "+ new session" button, footer overflow bug (resolved structurally by I3 +
a contextual hint line + a new `?`/`/help` overlay component, medium-high). **Consuming call site +
capture, added during round-3 plan-review** (round 2 fixed this two-part treatment for
`ThreadPicker.tsx` but left the help overlay — a second brand-new rendering surface — in the exact
same unverified state, the identical gap): the help overlay is mounted from `App.tsx`, toggled by
`?` (empty composer) or `/help`, rendered full-width in the dynamic tail listing the current
context's live keybindings. IB3's capture list (below) must include a dedicated asciinema recording
showing `?` opening the overlay, its content actually rendering (not just the toggle firing), and
dismissal — not folded silently into the "spinner + elapsed + esc" capture already planned for that
batch. I13 composer under-communicates
(`Composer.tsx`, `theme.ts`, placeholder teaches `/`+`?`, low); I14 permission prompt no esc/no
default/no scope, D1's coexistence resolution (`PermissionPrompt.tsx`, `Composer.tsx:55-62`,
arrow+enter nav with visible default, esc/ctrl+c = deny, high); I15 footer must not become a
permanent task dashboard — **no code**, a VERIFICATION.md design note + code comment only,
forward-looking guardrail (low); I16 stray keystrokes crossing pane boundary — resolved
structurally by I3 (no pane focus model left) + I14, verified explicitly in IB4's capture.

## Batch structure & sequencing

Ink's dependency chain (the scrollback decision forces sidebar removal + de-framing into the same
change) makes IB1 the one large architectural batch; everything after it is smaller and stable.
Web batches are mutually independent. Alternating platforms after IB1 keeps both visibly evolving.

| Order | Batch | Contents | Visual moment |
|---|---|---|---|
| 1 | **IB1 — Terminal-native canvas** | I1, I2, I3 (minimal picker), I4, I5 | Scrollback survives, terminal bg shows through, frame gone, resizes live |
| 2 | **WB1 — Run-state package** | W1, W2, W3, W4 | Full streaming lifecycle: shimmer → cursor → stop → error retry |
| 3 | **IB2 — Content grammar** | I6, I7, I8, I9, I10 | Transcript reads like Claude Code: unboxed, capped, one glyph family |
| 4 | **WB2 — Sidebar & navigation** | W5, W6, W7, W8, W9 | Overflow menus, truthful buckets, search, collapse, modal drawer |
| 5 | **IB3 — Run-state & discoverability** | I11, I12, I13 | Spinner + elapsed + interrupt; hint row; help overlay |
| 6 | **WB3 — Message affordances** | W10, W11, W12, W13 | Hover actions, working edit-to-branch, disclosures |
| 7 | **IB4 — Permission overhaul + polish** | I14 (D1), I15 note, I16 verification | Arrow-navigable approval dialog replacing the composer slot |
| 8 | **WB4 — Composer & empty state** | W14, W15, W16 (D3), W17, W18 | Real model picker, honest empty state, approval-state composer |

Each batch = one Workflow invocation = one commit pushed to PR #78 after code-review reaches SHIP,
so the PR history mirrors the visual checkpoints.

**IB1's dispatch prompt must additionally require:** (a) the committed-renderer feasibility spike
(constraint 3 above) proven first, before the rest of the batch is built on it; (b) codegraph-first
exploration baked directly into the agent prompts (Workflow subagents inherit no exploration hook);
(c) preservation of the documented known upstream bug boundary in `App.tsx:123-137` (the two-rapid-
`ctrl+n` draft-bleed issue stays explicitly out of scope — don't regress the already-fixed
single-`ctrl+n` case).

## Verification & capture strategy (per batch)

Satisfies this repo's blocking `visual-verification-required` rule (**corrected during round-4
plan-review** — this section previously cited the wrong rule name; the correct id is used
consistently elsewhere in this plan, e.g. I3's consuming-call-site fix): every batch appends
real rows to `proto/VERIFICATION.md` (feature / expected / observed / **verified-by** / PASS-FAIL)
and lands real artifacts under the **established per-app paths** — `proto/web-app/captures/verify/`
and `proto/ink-app/captures/verify/` (**corrected during plan-review**: `proto/captures/` does not
exist and contradicts the original build's own established pattern, `FINDINGS.md:115,215` — a
batch dispatch told to write to the wrong path would either fail or silently invent a new
convention; use the real existing directories). **`verified-by` column, added during round-3
plan-review**: one of `batch-agent` (the implementing dispatch's own claim), `fable-review` (caught
during that batch's code-review pass), or `user-spot-check` (independently re-verified firsthand by
the orchestrating session per the named-claim list below) — without this, a subagent's self-claimed
PASS and a genuinely independent re-verification are indistinguishable in the record, which is the
one distinction this plan's whole execution model rests on.

**`expected` values are frozen from a durable, versioned copy of this plan, not the plan file
itself** (the local plan-mode file is mutable — it was already overwritten once this session, and
the original build's own `VERIFICATION.md:3-6` cites that same kind of local, machine-specific path as its
frozen-expected source, which is now stale since this plan replaced it). Before IB1 starts, copy
this plan's finalized content to `proto/design-source/lia496-fix-plan.md` (inside the worktree,
diff-visible, immutable once committed) and cite *that* repo-relative path as the frozen-expected
source in every batch's `VERIFICATION.md` entries — never a local machine path. **IB1 must also
update `proto/VERIFICATION.md:3-6`'s own header** (added during round-4 plan-review — otherwise the
file's header keeps citing the now-stale local plan path while every new row underneath cites the
correct `proto/design-source/` path, a contradiction inside the same file) to point at
`proto/design-source/lia496-fix-plan.md` as well.

**Public-repo sanitization requirement, added during round-2 plan-review (blocking):** this plan's
own draft text contains absolute local paths used only to point the planning process at source
material — these must NOT be copied verbatim into `proto/design-source/lia496-fix-plan.md`, since
the `deus-v2` repo is a **public** repo (confirmed via `gh repo view --json isPrivate` → `false`)
and an absolute local-machine path rooted at a personal home directory is exactly the class of
personal-value leak this plan already fixes at I5's sidebar hardcode — committing one here while
blocking one there is inconsistent. **Sweep instruction, made mechanical during round-3 plan-review**
(a prose enumeration of "where these live" goes stale the moment the plan itself is edited again —
this round's own fixes already added a new absolute path outside the originally-described set):
before writing the committed copy, grep the draft for absolute filesystem paths rooted at a
user's home directory, for home-relative shorthand paths, **and for the bare account username**
(**corrected during round-4 plan-review** — the path-shaped patterns alone would satisfy "zero
home-directory-path occurrences" while still leaving the literal name outside any path — the same
lines this sweep targets also carry it as plain text, e.g. the sidebar identity fix at I5) — zero
occurrences of any of the three may remain in `proto/design-source/lia496-fix-plan.md`. Replace
each with a repo-relative reference or a generic placeholder (e.g. "the review artifact" / "this
session's planning transcript"). **This same discipline extends forward to every batch's own
output, not just this one copy:** all `VERIFICATION.md` rows and `captures/verify/results.json`
artifact-path fields must be `proto/`-relative (e.g. `proto/ink-app/captures/verify/...`), never an
absolute personal-home-directory path — run the same home-directory-path/username grep sweep as part of each
batch's own review pass, since pre-existing entries in this build's
`VERIFICATION.md`/`SETUP-NOTES.md`/`results.json` already
leak absolute paths this way (a known pre-existing issue, out of scope to retroactively clean up,
but new batches must not add to it).

- **Web batches — Playwright** (the established LIA-495/496 pattern): screenshots per feature
  state, plus timed sequences for motion (WB1: streaming with cursor visible, stop mid-stream,
  post-stop retry; WB2: drawer open → select → auto-closed at 390×844 and 1440×1000; WB4: 6-line
  composer geometry, picker open with an ARIA snapshot).
- **Ink batches — tmux + asciinema** (same established pattern). **IB1's two architectural proofs,
  strengthened during plan-review** (the original pair is necessary but not sufficient — a build
  that never adopted `<Static>` at all could still pass a naive version of both, since
  `ink.js:322`'s destructive clear only fires once dynamic output height reaches the terminal's row
  count, which a short test transcript never reaches):
  1. **Scrollback preservation — content-identity, not just line count:** `tmux capture-pane -S -
     -p | wc -l` before/after streaming a long thread and switching threads must *grow* (the
     original failing capture returned exactly 40 lines) — AND, additionally, a specific literal
     string from the FIRST message sent (before any thread switch) must still be found via `tmux
     capture-pane -S - -p | grep` after switching threads and sending more messages. Line-count
     growth alone doesn't prove *that specific content* survived; the grep for known text does.
  2. **No destructive clear — the discriminating test is a forced-tall run, not a normal-size one.**
     **Corrected during round-2 plan-review** — the original single-giant-part version of this test
     directly contradicted constraint 2 above, which already concedes "a single in-flight message
     taller than the terminal would still trip the clear path once": start the pane genuinely small
     (e.g. `-y 15`) and drive one streaming message that is **multi-part** (e.g. reasoning + a tool
     call + closing text), where **each individual part** stays under the dynamic-region budget
     (pane rows minus status row minus composer) but the **message's total committed length**
     exceeds the pane height once all parts have streamed and committed. This exercises
     `ink.js:322`'s trigger condition on the *cumulative* dynamic-vs-static boundary without
     tripping the plan's own acknowledged residual case (a single part alone exceeding the budget —
     that specific scenario is out of scope for this proof, not silently retested until it passes).
     Grep the raw PTY byte log (`script`/`tee`) for `\x1b[3J` — must be absent for this multi-part
     forced-tall case, not just in a normal-size session that never reaches the trigger at all
     (which would pass trivially on a broken build).
  3. Resize demo at 80 and 120 columns, captured as asciinema.
  4. **`ThreadPicker.tsx` (I3) walkthrough, added during round-2 plan-review:** ctrl+t opens the
     overlay, arrow-key navigation between at least two seeded threads, `n` triggers new-session
     creation, picker closes on selection and on esc — captured as its own asciinema recording, not
     implied by another proof.
  IB2: a >5-line Bash result collapsed + ctrl+o expanded; diff rendered unboxed at the new
  responsive width. **IB3:** spinner + elapsed running, esc actually cancelling, **plus a dedicated
  recording of `?` opening the help overlay with its content visibly rendered and dismissal
  working** (added during round-3 plan-review — this overlay is a new component, not covered by
  the spinner/esc capture). IB4: full approval keyboard walk (arrows, enter, esc-deny, y/a/n
  accelerators) as asciinema.
- Every batch also runs `proto/scripts/check-shared-purity.sh` (must stay green), `tsc --noEmit` on
  all three workspaces, and the existing verify scripts.

## Execution model — how progress is actually visible throughout

Workflow only notifies on full completion of a dispatch, not mid-run, so this runs as **eight
separate Workflow invocations**, one per batch above, in order. Between each completion:

1. Pull the batch's fresh captures from `proto/{web-app,ink-app}/captures/verify/` and the new
   `VERIFICATION.md` rows.
2. **Independently spot-verify one NAMED claim per batch firsthand** (**corrected during
   plan-review** — "1-2 claims" with no selection criterion is unfalsifiable; each batch gets
   exactly one pre-named, highest-risk claim, checked the same way every time so the practice
   survives time pressure):
   - IB1: the forced-tall-pane no-`\x1b[3J` proof — re-run it myself, don't trust the batch's own
     capture.
   - WB1: the stop-generating control actually halts token output mid-stream (not just that the
     button renders) — send a message, click stop mid-stream, confirm no further text appends.
   - IB2: a real >5-line Bash result genuinely collapses then expands via ctrl+o — re-attach the
     tmux session and press the key myself.
   - WB2: the time-bucket fix — re-check that the ~9-day-old seed thread (the one sanctioned
     fixture change) renders under the correct bucket, not "Yesterday".
   - IB3: esc genuinely interrupts a running turn — re-attach and press esc mid-stream.
   - WB3: `composer.beginEdit()` genuinely creates a navigable sibling branch — re-run the edit
     flow, confirm the branch picker shows 2/2.
   - IB4: the full keyboard walk (arrows/enter/esc-deny/y/a/n) on a live permission prompt — redo
     it myself in a fresh tmux session, not just read the batch's asciinema.
   - WB4: the model-picker dropdown genuinely toggles between the two scripted labels via real
     click + keyboard — click it myself.
   A subagent's PASS is a hypothesis until confirmed this way, per this repo's own
   delegated-conclusions rule — this is not new process, just made concrete per batch.
   **Writer for `verified-by`, added during round-4 plan-review** (the column had no step that
   actually wrote to it): after re-verifying the named claim, amend that batch's `VERIFICATION.md`
   row for it to `verified-by: user-spot-check` (or `FAIL` with the specific discrepancy) — without
   this every row defaults to `batch-agent`/`fable-review` and the column carries no real signal.
3. Update one cumulative before/after Artifact (same pattern as the review HTML): a strip of
   before → after images/gifs per batch, building up across all eight checkpoints. **Republish
   mechanism, made explicit (plan-review Q3):** the Artifact tool only updates an existing page
   when the SAME `url` from the artifact's first publish is passed on every subsequent call —
   omitting it mints a new URL. Save that URL after IB1's first publish and pass it explicitly on
   all seven follow-up republishes, so the user watches one evolving page, not eight separate
   links.
4. Only then dispatch the next batch's Workflow.

Eight genuine visual checkpoints, each backed by real evidence and one named re-verified claim,
cumulative progress visible the whole way through — no single end-reveal.

## Model assignment (per standing instruction for this thread)

Planning → Fable (this plan). Plan-review → Opus 5 (next step). Implementation agents inside each
batch's Workflow → session default (Sonnet). Code-review per batch → Fable, a fresh agent every
round (never a resumed agent, per this repo's verdict-capture rules) — same shape as the original
build's review stage.

**Cross-repo gate gap, stated explicitly (added during round-2 plan-review):** every batch commits
to the `deus-v2` repo while the driving session is anchored in the primary `deus` repo checkout.
Per this repo's own `orchestration-rules.md` § Cross-Repo Worktree Handling, the plan-review gate
no-ops on foreign-repo paths, and the commit-side warden/ai-eng gates can be satisfied by a stale,
unrelated SHIP sitting in a primary-repo-side bucket without ever reading the actual `deus-v2` diff
— no hook here provides real protection for this class of commit. The per-batch Fable code-review
named above is therefore the *only* real gate, not a supplement to an automated one — each dispatch
must explicitly point the reviewer at the actual `deus-v2` worktree diff (a `git -C`-scoped diff
against the `deus-v2-mvp` worktree for this branch, not a bare `git diff`), same discipline the
original build's S4 stage already used.

## Scope guardrails

- No backend wiring. All fixes are presentation/interaction; the shared runtime contract
  (`adapter.ts`, `threadList.tsx`) changes only where a finding requires actual logic, never
  presentation values — `check-shared-purity.sh` is the gate, and the `tokens.ts` lesson from
  LIA-495 stands: status colors/glyphs stay per-target.
- **Exactly three sanctioned fixture/shared-data changes, named up front — no others:**
  1. **WB2:** one seed thread's `lastMessageAt` moves to ~9 days ago so the truthful "Previous 7
     days/Older" bucket is demonstrable (without this, truthful bucketing can't be visually shown).
  2. **IB2 (conditional):** if no existing scripted Bash result already exceeds the 5-line cap,
     lengthen exactly one by a few honest lines so collapse/expand is demonstrable — the
     implementing agent states in `VERIFICATION.md` whether this was actually needed.
  3. **WB1 (logic, not data):** scripted generators check `options.abortSignal` between yields so
     Stop actually halts output promptly — a shared runtime-logic change, purity-safe, explicitly
     allowed (distinct from a presentation-value change).
  The web model-picker's second label (D3) is web-app-local presentation state, deliberately kept
  out of `shared/`.
- No-code findings are recorded as design notes, not invented into code: I15 (task-dashboard
  guardrail) lands as a `VERIFICATION.md` note + one code comment, nothing else.

## Risks / deviations to watch

1. **Committed-renderer prop reconstruction (IB1)** — highest-risk item in the whole plan; proven
   via a minimal spike first, per the constraint above.
2. **`<Static>` immutability** — completed turns can't be restyled after commit; a later batch
   touching message chrome (IB2) only affects *newly* committed turns in a running session. Fine
   for a spike; note it explicitly in IB2's `VERIFICATION.md`.
3. **Known upstream store-staleness bug** (`App.tsx:123-137`, the double-ctrl+n draft-bleed) —
   IB1's picker must route thread switching through the same reactive paths the existing fix uses;
   stays documented-out-of-scope, not silently regressed.
4. `composer.beginEdit()` (W10) is named by the reviews as library-provided — **corrected during
   round-4 plan-review**: `ThreadPrimitive.ScrollToBottom` (W3) was already independently confirmed
   real (`primitives/thread/ThreadScrollToBottom.d.ts`, no fallback needed — see W3's own entry
   above; this item previously duplicated a stale pre-confirmation caveat and contradicted that
   fix). `beginEdit()` itself is confirmed to exist (`composer-runtime.d.ts:198`), but
   `proto/FINDINGS.md:116` records it as a currently-unwired product gap — verify it behaves as
   expected against a real edit flow during WB3, not just that the method exists.

## Framing note

Two items (I15, and the web review's own methodology caveats) are guardrails/notes with no code
referent. These are planned as recorded design notes rather than manufactured code changes — the
honest reading of "fix" for a finding that isn't itself a bug. Flag if literal code is wanted for
I15 instead (e.g., a lint comment-gate) — nothing else in the plan depends on that choice.

## Key reference files

- `proto/ink-app/node_modules/ink/build/ink.js:320-349` — the verified `<Static>`/scrollback
  mechanism this plan's central architectural decision rests on.
- `proto/ink-app/src/App.tsx:123-137` — the documented, out-of-scope upstream store-staleness bug
  boundary that IB1 must not regress.
- The published review artifact (this session's review job output, job id `d4c546e7`) — the
  authoritative, final-merged review this whole plan is fixing.
- `proto/FINDINGS.md` (from the original build) — established capture/verification patterns
  (Playwright for web, tmux+asciinema for Ink) this plan reuses rather than reinventing.
