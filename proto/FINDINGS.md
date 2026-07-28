# LIA-495 — assistant-ui web-first → Ink migration spike: FINDINGS

Question this spike answers: if the eventual tui-v2 real migration ever needs
to go **web-first, then port to Ink** (rather than Ink-first, which is what
LIA-493 already validated in the sibling `proto-lia493-assistant-ui-ink`
worktree), does the shared-runtime/thin-UI-layer split actually hold up in
that direction too — and is the resulting workflow worth recommending?

Two prototypes, both under this worktree's `proto/`:

- `proto/web-first-demo/` — the same 6-piece full shell (header/status,
  spinner, streamed transcript with tool-call bullets, inline diff moment,
  inline three-way permission interrupt, footer task tracker) built fresh
  against `@assistant-ui/react` (the web/DOM package), starting from
  `full-shell.tsx` (LIA-493 round 5's Ink reference) as the spec to port.
- `proto/migrated-ink-demo/` — that same web build ported back to
  `@assistant-ui/react-ink`, testing whether `src/runtime/*.ts` really is
  reusable with near-zero changes across backends, the way the
  assistant-ui.com migration docs claim.

## 1. Web build (`proto/web-first-demo/`)

**Built successfully**: yes. `npm run build` (`tsc -b && vite build`)
completes clean — 668 modules transformed, 0 errors.
`npx oxlint` is clean except one pre-existing, unrelated warning in
`captures/run-capture.mjs` (an unused var in a Playwright fixture script).

All 6 required pieces are present, each ported line-by-line from
`full-shell.tsx`:

1. **Header/status bar** — `Header.tsx`, same 3-state
   idle/working/awaiting-approval color logic as the Ink reference, CSS
   bottom-border instead of an Ink `Box` border.
2. **Spinner/rotating-word** — `Spinner.tsx`, same rotating-gerund hook and
   950ms cadence; Ink's `LoadingPrimitive.Spinner` glyph (confirmed absent
   from `@assistant-ui/react`'s web export — zero matches for "spinner" of
   that shape) is replaced with a CSS `@keyframes` rotation.
3. **Streamed transcript with tool-call bullets** — `Messages.tsx` +
   `BashToolUI.tsx`/`EditToolUI.tsx`, same "⏺ ToolName(args)" convention and
   pending/success/error bullet coloring, ported verbatim from
   `statusColor.ts`.
4. **Diff moment** — `DiffPanel.tsx`. **Honest gap #1**: `@assistant-ui/react`
   has no `DiffView`/`DiffPrimitive` at all (zero matches for "diff",
   case-insensitive, anywhere in the installed package's `.d.ts` or `dist`
   file names) — so the line-by-line diff renderer (`RawDiffLines`) is
   hand-built, not a port. The chrome around it (path link, +/- counts, "not
   applied" warning, status border) is ported verbatim.
5. **Inline three-way permission interrupt** — `PermissionToolUI.tsx`.
   Preserves the exact library data model
   (`ToolCallMessagePart.approval`/`ToolApprovalOption[]`/
   `respondToApproval`) and the critical sequencing finding from the Ink
   reference: perform the delete + record its outcome in a module-level map
   *before* calling `respondToApproval`, never via `addResult`, to avoid
   racing `shouldContinue`'s auto-continuation.
6. **Footer/task tracker** — `TasksFooter.tsx`. **Honest gap #2**:
   `@assistant-ui/react` has no checklist primitive either (`LiveChecklist`/
   `ChecklistPrimitive` are Ink-only) — hand-rolled from the same
   `useApprovalTaskStatus`/`useToolTaskStatus` hooks that drove the Ink
   version's `LiveChecklist`.

Reasoning-group rendering is the one surface with a genuine cross-target
contract: both packages re-export `ReasoningGroupComponent`/
`ReasoningGroupProps` from `@assistant-ui/core`, type-only — a shape
contract you implement against, not a ready component.

### Playwright-verified capture

Driven against the live Vite dev server (real `page.fill`/`page.press`/
`page.click`, headless Chromium — not static HTML). Screenshots at
`proto/web-first-demo/captures/verify/01-initial-load.png` through
`09-final-settled.png`, plus a full session video at
`captures/verify/video/page@*.webm`.

Verified end-to-end: composer accepts real typed text and submits on real
`Enter` (this closes a genuine regression the earlier CAPTURE stage had
found and documented — `03-after-enter-BROKEN-no-submit.png` — the textarea
had been outside any `<form>`; the fix was wrapping
`ComposerPrimitive.Input` in `ComposerPrimitive.Root`, confirmed in the live
DOM via `closest("form")`); the streamed `Bash` tool-call bullet renders
with real output; the permission chooser renders and a real `<button>`
click ("Allow once") resolves it; the `Edit` tool call renders a genuine
unified diff; the footer task tracker progresses 0/3 → 2/3; zero console
errors across the run.

## 2. Migration to Ink (`proto/migrated-ink-demo/`)

Fresh, standalone Ink package (own `package.json`/`tsconfig.json`, deps
`@assistant-ui/react-ink@0.0.33` + `@assistant-ui/core@0.2.22` + `ink@^6` +
`react@^19`, matching the proven-working versions from the sibling
`proto-lia493-assistant-ui-ink` worktree as a version reference only — not a
copy of that worktree's files).

### The core question: did the shared runtime actually stay shared?

Independently re-verified with real `diff -u` against every file in
`src/runtime/`, not taken on the migration stage's word:

| File | Result |
|---|---|
| `diffStatus.ts` | **byte-identical** (`diff` exit 0) |
| `fixtures.ts` | **byte-identical** |
| `permissions.ts` | **byte-identical** |
| `statusColor.ts` | **byte-identical** |
| `util.ts` | **byte-identical** |
| `virtualFs.ts` | **byte-identical** |
| `adapter.ts` | only the type-only import specifier line changed (`@assistant-ui/react` → `@assistant-ui/react-ink`); every line of actual logic — the whole `ChatModelAdapter`, the scripted-turn generators, the streaming/branching logic — is untouched |
| `hooks.ts` | only the import specifier changed the same way, plus header-comment prose describing the reversed direction; the hook bodies are untouched |
| `tokens.ts` | **genuine value change**: web-first-demo's `tokens` object holds CSS custom-property strings (`"var(--cc-text-muted)"`, resolved by `index.css`); Ink's `<Text color>` prop (chalk) cannot resolve a `var(...)` string at all, so these were restored to the literal hex values `full-shell.tsx`'s own `tokens` object used. `BULLET`/`GERUND_WORDS`/`sleep` in the same file are untouched. |

**Verdict: PARTIALLY_CONFIRMED.** 6 of 9 runtime files are genuinely
byte-identical, 2 more needed exactly one import-specifier line changed with
zero logic difference — that's the "shared runtime" claim holding up almost
exactly as advertised for the parts that matter most (the actual streaming
adapter and state-derivation hooks). The one real exception is `tokens.ts`,
and it's a narrow, well-understood one: color *values* had to change because
they were expressed as DOM CSS custom properties, which is a
presentation-layer leak into what was nominally a "runtime" file, not a
logic change. This is exactly the kind of exception the ticket anticipated
("if a runtime file needs a real logic change, that is an important, honest
finding") — it isn't a crack in the migration-pattern claim, but it is a
concrete caveat: **"shared runtime" only holds cleanly if that runtime layer
is kept free of target-specific presentation values (CSS strings, DOM
units, etc.) from the start.** A future real migration should treat
color/spacing constants as a target-specific concern from day one (e.g. a
small `theme.web.ts`/`theme.ink.ts` pair), not bury them in the "shared"
file and discover the leak only when porting.

### UI layer

All 13 pieces reimplemented against `@assistant-ui/react-ink` primitives,
restoring the same primitives `full-shell.tsx` originally used:
`LoadingPrimitive.Spinner`, `DiffView`, `LiveChecklist`, Ink's real
`useInput`-based key handling, the OSC-8 hyperlink for tool paths, and
`useNotification` (a real terminal BEL/OSC-9 — restored here since it's
genuinely present on Ink and was the mirror image of the DiffView/
LiveChecklist gap on web). ~635 LOC across the UI layer.

## 3. Code review (round 1) — REVISE, findings fixed here

`codex exec` review (read-only, live file content since everything under
`proto/` was untracked) returned **REVISE** on 2 High + 1 Medium + 2 Low
findings. All five were fixed in this RECONCILE stage and re-verified:

- **High — fresh installs were not runnable.** `@assistant-ui/react-ink` →
  `@assistant-ui/core/react`'s barrel statically imports the optional peer
  `assistant-cloud`, which has no real npm package; the app only worked via
  a hand-written inert stub in `node_modules/assistant-cloud/` that was
  git-ignored (repo-wide `node_modules/` rule) and therefore invisible to a
  fresh clone/`npm install` (`ERR_MODULE_NOT_FOUND`). **Fix**: force-tracked
  the stub (`git add -f node_modules/assistant-cloud/{package.json,index.js}`),
  matching the identical, already-accepted workaround the sibling
  `proto-lia493-assistant-ui-ink` worktree uses for the same root cause.
- **High — "Always allow" didn't persist, despite the UI claiming it does.**
  `PermissionToolUI.tsx` labeled the `allow-always` option "(persists until
  revoked)", but `confirm()` collapsed `allow-once`/`allow-always` to the
  identical boolean `approved`, and neither `permissions.ts` nor
  `adapter.ts` threaded `optionId` anywhere — there was no grant store on
  either target. Independently confirmed this was a **pre-existing defect
  ported faithfully from web-first-demo**, not introduced by the migration
  (identical collapse at the identical line in both `PermissionToolUI.tsx`
  files). **Fix**: removed the misleading "(persists until revoked)" label
  from both targets rather than bolting on new persistence logic mid-review
  — the honest fix for a UI claiming behavior neither target implements is
  to stop claiming it, not to invent new scope. A real "always allow"
  grant store is out of scope for this spike; noted as a gap, not silently
  fixed with unreviewed new logic.
- **Medium — deprecated tool-UI hook re-registered on every message.**
  `useAssistantToolUI` (marked `@deprecated` in `@assistant-ui/core` in
  favor of `MessagePrimitive.Parts`'s inline `components.tools.by_name`) was
  called from `AssistantMessage`, which mounts fresh per rendered message —
  so each new message re-ran all 3 registrations. Read `setToolUI`'s
  implementation directly: it's a `Map.set` keyed by `toolName`, so this was
  never a correctness bug (later calls just overwrite with the same value),
  but it was still real per-message waste for a thread-wide concern. **Fix**:
  extracted the three registrations into a new `ToolUIRegistrations`
  component, mounted once at the `App` root (sibling to
  `ThreadPrimitive.Root`) in both targets, instead of inside the per-message
  component.
- **Low — unsafe empty-options handling.** `options[index]!` (non-null
  assertion) in `confirm()`, with `% options.length` in the arrow-key
  handling; an empty `options` array (not prevented by the prop type) would
  dereference `undefined` on Enter and produce `NaN` on arrow movement.
  **Fix**: `confirm()` now early-returns on a missing option instead of
  asserting; both targets' key handlers (`useInput` on Ink, `onKeyDown` on
  web) early-return when `options.length === 0`.
- **Low — `DiffView` header rendered twice.** The Ink `DiffPanel.tsx`
  hand-rendered a filename + `+`/`-` counts row, then also mounted
  `DiffView`, which renders that identical header internally (confirmed by
  reading `dist/primitives/diff/DiffView.js` directly — it builds its own
  `Box`/`Text` header per file from `file.additions`/`file.deletions`).
  **Fix**: removed the now-redundant hand-rolled header row from the Ink
  `DiffPanel.tsx`, keeping only the "not applied" badge and status border
  (which have no library equivalent). Visually confirmed fixed in the
  re-capture below — one header line, not two.

`npx tsc --noEmit` (Ink) and `npx tsc -b` (web) both pass clean after every
fix. `npm run build` (web) still completes clean (668 modules, 0 errors).
Findings the review confirmed were **not** defects — runtime-reuse table,
UI-primitive usage against the actual installed package API, the deny-path
trace, dependency-version parity against the sibling worktree — are not
re-litigated here; they held.

## 4. Ink capture (re-recorded post-fix)

Recorded live, not scripted against static output: a `120x40` tmux pane
running `asciinema rec -c 'npx tsx src/main.tsx'
captures/verify-flow.cast`, driven with real `tmux send-keys -l "<text>"` +
a separate `Enter` — the same mechanism a human typing at the keyboard
would produce — converted to gif via `agg` (ffmpeg remains broken on this
host — confirmed again this session, unrelated to this work). Five stills
extracted via Python `PIL.Image.seek()` (ffmpeg substitute, per the
established pattern) at
`proto/migrated-ink-demo/captures/verify/`:

- `01-initial-idle.png` — idle header, empty task list, composer focused.
- `02-reasoning-streaming.png` — "⏺ Thinking…" block streaming, header
  reading "Working", spinner active.
- `03-permission-prompt.png` — the real `Bash` existence check result, then
  the inline "Permission required" box (`1. Allow once` / `2. Always allow`
  / `3. Deny`) with the composer swapped for the muted "Resolve the
  permission prompt above to continue…" placeholder. **Confirms the "Always
  allow" label fix**: no "(persists until revoked)" text next to option 2.
- `04-permission-resolved.png` — after sending `"1"` (a real keystroke, not
  a prop injection): the row collapsed to `⏺ delete_file(...) — Allow once
  (deleted)`, task tracker at 1/3, turn auto-resumed into the `Edit` call.
- `05-diff-rendered-final.png` — the resolved `Edit` diff panel and footer
  at 2/3 done (same stopping point web's capture used, for a fair
  side-by-side). **Confirms the duplicate-header fix**: the diff panel shows
  exactly one `path +3 -3` header line, not two.

## 5. Overall assessment — is "web first, then port to Ink" a good workflow for tui-v2?

Qualified yes, with one important caveat about where the split line has to
be drawn.

**What held up well:** the central premise — a DOM-free `runtime/` layer
(streaming adapter, state-derivation hooks, data models, pure helpers) that
ports across `@assistant-ui/react` and `@assistant-ui/react-ink` with
near-zero change — is real, not aspirational. 6 of 9 files were literally
byte-identical; the 2 that changed needed exactly one import line each, with
the entire `ChatModelAdapter`/streaming/branching logic — the part of a
migration most likely to hide subtle bugs — completely untouched. That's a
strong result for whichever direction tui-v2 actually goes.

**What the caveat is:** the one runtime file that *did* need a real change
(`tokens.ts`) failed specifically because it mixed target-neutral logic with
target-specific presentation values (CSS custom-property strings) in the
same "shared" file. That's a discipline problem, not a framework problem —
but it's exactly the kind of thing that's invisible until you actually
attempt the port, which is the whole point of doing this spike before
committing to an approach for real. **Recommendation for the real tui-v2
migration: draw the runtime/UI boundary so that colors, spacing, and any
other presentation constants live in a small target-specific file from the
start** (as this spike had to retrofit), not inside the "pure" runtime
layer — everything else about the shared-runtime pattern is trustworthy
enough to build on directly.

**On build order specifically** (web-first vs. Ink-first, this ticket's
actual question): building the web version first did surface two genuine,
honestly-flagged primitive gaps (no `DiffView`, no checklist primitive on
`@assistant-ui/react`) that had to be hand-built — and when ported back to
Ink, those hand-built pieces were correctly *replaced* with the real
library primitives rather than kept as unnecessary reimplementations. That
round-trip worked cleanly and is reassuring: it means the "what's missing on
this target" discovery an engineer does while building either version first
transfers directly to knowing what to swap back in on the other target.
There's no evidence in this spike that one build order is meaningfully
safer or riskier than the other for the runtime-reuse guarantee — LIA-493
(Ink-first) and this spike (web-first) both landed on the same "6-8 of 9
runtime files needed zero or import-only changes" result. The real driver
for tui-v2 should be **which target has the harder-to-discover gaps for the
team's actual final feature set**, since building that target first
front-loads the riskiest discovery; that's a product-scope question this
spike doesn't answer either way.

**On code review discipline for this kind of prototype work**: worth
noting plainly that this stage's review round found 5 real, fixable issues
in code an earlier stage's own report had described as fully verified and
working — including one (the untracked `assistant-cloud` stub) that would
have broken a fresh clone outright. None of the findings were exotic; all
were caught by a single read-only review pass. That's a concrete data point
for keeping the review gate in the loop even on "just a spike," not
evidence the earlier stages did sloppy work — prototypes accumulate exactly
this kind of edge case, and a review pass before calling something done is
what catches it.
