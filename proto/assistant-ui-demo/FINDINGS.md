# LIA-493 — @assistant-ui/react-ink Prototype Findings

Throwaway evaluation prototype (wayfinder map LIA-492) assessing
`@assistant-ui/react-ink` as a candidate rendering foundation for `tui-v2`'s
hand-rolled Ink screens. Two independent screens were built in this worktree
by sibling agents and are reconciled here. This document is a reference
artifact for a human decision — it is not a mergeable feature and this
branch should not be turned into a PR.

## Screen 1 — Permission Prompt (`src/permission-screen.tsx`)

- **Built successfully:** yes (verified — file exists, 10765 bytes / ~247 LOC
  incl. provenance comments).
- **Artifacts (verified present, non-empty):**
  - `captures/permission-flow.cast` (17,237 bytes)
  - `captures/permission-flow.gif` (49,245 bytes)
  - `captures/frame-mid.png` (26,385 bytes)
  - `captures/frame-last.png` (23,353 bytes)
  - `captures/frame-check.png` (9,576 bytes) — an extra still not mentioned in
    the self-report; present but not otherwise documented.
- **LOC estimate:** 247 (self-reported, consistent with file size).

### Friction notes

Built a self-contained `permission-screen.tsx` registering a custom
`ToolCallMessagePartComponent` via `useAssistantToolUI` for a `delete_file`
tool, driving a hand-rolled `useInput` cursor loop over 3 `ToolApprovalOption`
rows (allow-once / allow-always / reject-once, mirroring Deus's real
`PermissionDecision` + `PERMISSION_LIST_OPTIONS`), confirmed with
`respondToApproval({approved, optionId})`.

**Blocking packaging bug (worked around, not silently):** `@assistant-ui/core`'s
react barrel (`dist/react/index.js`) statically imports `assistant-cloud` — a
peer dep marked optional in `peerDependenciesMeta` — via
`AssistantCloudThreadHistoryAdapter.js` / `useCloudThreadListAdapter.js`.
Since it wasn't installed, merely importing anything from
`@assistant-ui/react-ink` crashed at module-load with
`ERR_MODULE_NOT_FOUND`, regardless of whether cloud features are used.
Confirmed via stack trace, not assumed. Per the "no `npm install` again"
constraint, the agent did not run `npm install`; instead it hand-authored a
2-file inert local stub package at `node_modules/assistant-cloud` (3 dummy
exports: `AssistantCloud`, `CloudMessagePersistence`,
`createFormattedPersistence`) that satisfies only the static import —
additive, doesn't touch `package.json`/`package-lock.json`.

**Real API gap found only by running it** (undocumented in the `.d.ts`
surface the setup stage read): `respondToToolApproval`
(`local-thread-runtime-core.ts:679`) throws "message whose status is not
requires-action" unless the `ThreadAssistantMessage`'s own `status` field is
exactly `{type:"requires-action", reason:"interrupt"}` — a MESSAGE-level
flag, not derivable from the tool-call part's own approval/interrupt fields.
First adapter draft omitted it and the chooser crashed the instant Enter was
pressed. Fixed by yielding `status` alongside the tool-call content.

**What the library gave for free:** the approval data model
(`ToolCallMessagePart.approval` / `ToolApprovalOption[]` / `respondToApproval`)
is real and load-bearing — once `requires-action` status was set correctly,
propagating Deus's 3-way decision through it and reading the resolved
`optionId` back out of `props.approval` worked exactly as documented, with
zero extra plumbing.

**What was 100% hand-built** (matches the setup stage's own prediction): the
entire interactive chooser — there is no Dialog/chooser primitive anywhere in
the package; this is a direct, single-file port of `PermissionModal.tsx`'s
`cursorIndex`+`options`+`useInput` shape (collapsed into one component rather
than the real code's global-TuiState+reducer split, since this is a
disposable single-file prototype; no auto-deny countdown implemented — out
of scope for this screen).

**Verification:** all three decision paths were run and confirmed
end-to-end in separate tmux sessions with clean (empty) stderr logs each
time — allow-once → green "✓ Decision: Allow once", always-allow → green "✓
Decision: Always allow", deny → red "✗ Decision: Deny" — never a
false-positive green on the deny path. The captured asciinema recording shows
cursor traversal through all 3 rows then confirms Allow once; stills of the
mid-traversal and final-resolved frames were extracted via Python PIL (ffmpeg
on this host is broken — dyld error, missing `libx265.215.dylib` — a
pre-existing host issue, so PIL substituted for frame extraction only; the
`.cast`/`.gif` themselves were produced via the prescribed asciinema/agg
pipeline). One non-fatal React "duplicate key" warning was observed once in
an early no-TTY smoke test before the status fix; it did not reproduce in any
of the three verified tmux/asciinema runs — noted as observed-once-not-
reproduced, not claimed fixed.

## Screen 2 — Diff Rendering (`src/diff-screen.tsx`)

- **Built successfully:** yes (verified — file exists, 7,554 bytes / ~188 LOC,
  ~110 LOC core logic excl. heavy doc comments).
- **Artifacts (verified present, non-empty):**
  - `artifacts/diff-screen.cast` (14,869 bytes)
  - `artifacts/diff-screen.gif` (40,403 bytes)
  - `artifacts/diff-screen-last.png` (59,144 bytes)
- **LOC estimate:** 188 total, ~110 core logic (self-reported, consistent
  with file size and comment density observed in the file).

### Friction notes

**What the library gave for free:** `DiffView`
(`primitives/diff/DiffView.js`) is a genuinely complete, self-contained
compound component — verified by reading it verbatim, it owns its own
`DiffRoot`/`DiffContext`, parses a unified-diff `patch` string via
`parse-diff`, computes intra-line segment highlighting, renders +/- gutters,
line numbers, and per-file add/del stat counts, all correctly, out of the
box. No `AssistantRuntimeProvider`/runtime wiring needed at all for this
screen — `DiffView` has zero dependency on assistant-ui's chat/runtime
context, only on `ink` and `@assistant-ui/tap`.

**Real friction found (not anticipated in the setup notes):** importing
anything from the package's only public entry point
(`@assistant-ui/react-ink`, bare specifier — `package.json` `"exports"`
permits only `"."` and `"./internal"`, no subpath for individual primitives)
crashes at runtime with `ERR_MODULE_NOT_FOUND: Cannot find package
'assistant-cloud'`. Root cause, confirmed by reading source: react-ink's
`dist/index.js` re-exports `@assistant-ui/core`'s react barrel, which has a
*static* top-level import of a `CloudThreadHistoryAdapter` requiring
`assistant-cloud` — declared only as a `peerDependency` of
`@assistant-ui/core` (npm registry confirms it's real, v0.1.36) and never
installed for a local-only, non-cloud demo, nor re-declared by react-ink
itself. This crash is not specific to `DiffView` — it hits ANY import from
the package's supported entry point, so it equally hits the sibling
permission screen the moment it imports `ThreadPrimitive`/
`AssistantRuntimeProvider` from the same barrel. **This is the same
underlying bug Screen 1 hit and worked around with the stub package** (see
reconciliation notes below).

**Workaround used (no `npm install`, per instructions):** imported
`DiffView` via a relative deep path straight into `node_modules`
(`../node_modules/@assistant-ui/react-ink/dist/primitives/diff/DiffView.js`)
instead of the bare package specifier. Node's `package.json` `"exports"` map
only gates bare-specifier resolution, not relative-path imports, so this
cleanly sidesteps the barrel (and its cloud import) entirely — verified
`DiffView.js`'s own import graph pulls in only `./DiffContext`, `./DiffRoot`,
`./diff-utils`, `./DiffContent`, `./intra-line-utils`, `@assistant-ui/tap`,
and `ink`, none of which touch `@assistant-ui/core`'s react barrel or cloud
code. This is brittle (relies on react-ink's internal dist layout, which
isn't a public contract) but was the fastest way to get a real running
artifact without adding dependencies or touching `package.json`.

**Ink-specific note:** the screen has no `useInput`/interval, so the Ink
process renders once and exits naturally when Node's event loop empties —
asciinema's recording ended on its own without needing a manual Ctrl+C,
which is why the resulting `.gif` only has 2 frames (initial blank + final
rendered state); this is expected for a static, non-interactive result
screen, not a capture failure. A still PNG of the last frame was captured
via Pillow for quick visual review since the `.gif`'s first frame (read by
an image viewer) is blank before Ink's alt-screen paints.

**Verified in the captured artifact** (`diff-screen-last.png` /
`diff-screen.cast`): success case shows a real unified diff (via `DiffView`,
add/del counts, colorized lines) under a green ✓; error case shows red ✗ with
NO diff panel (text-only explanation, "the write never ran"); unknown case
shows yellow ? — glyph is derived purely from `entry.status` via an
exhaustive switch with a `never`-typed default arm (copied verbatim from
production's regression-guard pattern in `ToolMessage.tsx`), never inferred
from diff presence/absence, so there is no code path that could produce a
green checkmark on a failed or indeterminate call. Confirmed by reading the
`statusGlyph` switch in `src/diff-screen.tsx` directly.

## Reconciliation notes (both screens hit the same root bug)

Both agents independently discovered and independently worked around the
**same** upstream packaging defect: `@assistant-ui/core`'s react barrel
statically imports the optional peer dependency `assistant-cloud`, so ANY
import from `@assistant-ui/react-ink`'s public entry point crashes at
module-load if `assistant-cloud` isn't installed — unrelated to whether the
importing code uses cloud features at all.

- Screen 1 fixed it at the **dependency** level: a hand-authored inert stub
  package at `node_modules/assistant-cloud` that satisfies the static import
  globally for the whole process.
- Screen 2 fixed it at the **import-site** level: bypassing the public
  barrel with a relative deep import straight to `DiffView.js`, which
  verifiably never touches the cloud-importing code path.

Because Screen 1's stub was in place first and patches the dependency
globally, Screen 2's workaround was likely never strictly necessary once the
stub existed — but both are kept here as independently-useful,
differently-shaped fixes; a real integration only needs one of them (most
likely the stub / an explicit `assistant-cloud` devDependency, since it's the
more general fix and doesn't depend on react-ink's internal `dist` layout
being stable).

### Verified discrepancy: the `assistant-cloud` stub is not committed by default

`node_modules/` is gitignored at the worktree root (`.gitignore:2`). Screen
1's self-report lists `node_modules/assistant-cloud/package.json` and
`node_modules/assistant-cloud/index.js` under `filesWritten` as if they were
ordinary deliverables, but because they live under `node_modules/`, a plain
`git add` of this directory does **not** pick them up — confirmed via
`git check-ignore -v`. Left as-is, anyone who clones this branch and runs
`npm install` would NOT get this stub back (it isn't a real npm package, it
has no registry entry), and would immediately reproduce the exact
`ERR_MODULE_NOT_FOUND` crash the stub exists to work around — the permission
screen would be unrunnable out of the box.

This is force-added (`git add -f`) as part of this reconciliation commit so
the branch is actually reproducible after a fresh clone + `npm install`. This
is flagged explicitly for whoever finalizes LIA-493: a real integration needs
`assistant-cloud` added as an explicit (dev)dependency, or the upstream
`@assistant-ui/core` package fixed to lazy-import it, rather than relying on
a hand-maintained gitignored-path stub long-term.

By contrast, Screen 2's workaround only reaches into
`node_modules/@assistant-ui/react-ink`, which IS a real declared dependency
(`package.json`: `"@assistant-ui/react-ink": "0.0.33"`) — `npm install` alone
correctly reconstructs it, so that half of the workaround needs no special
handling.

## Approval-primitive finding (from setup stage, reconfirmed against the built code)

CONFIRMED by reading `@assistant-ui/core`'s actual `.d.ts` source (not
assumption, not just docs): there IS a real approval data primitive —
`ToolCallMessagePart.approval` (`id`, `approved?`, `reason?`, `isAutomatic?`,
`options?: ToolApprovalOption[]`, `optionId?`, `resolution?`) plus
`ToolCallMessagePartProps.respondToApproval(response: ToolApprovalResponse)`
where options carry a `kind: "allow-once"|"allow-always"|"reject-once"|
"reject-always"` union — structurally a near-exact match for Deus's 3-way
`allow_once`/`allow_always`/`deny` decision. However there is **no pre-built
INTERACTIVE UI component** that renders this as a keyboard-driven chooser:
the package's only built-in tool-call renderer (`ToolFallback`/
`ToolCallPrimitive.Fallback`, read verbatim from
`dist/primitives/toolCall/ToolFallback.js`) treats its `'requires-action'`
status as text-only ("Waiting for approval..." in cyan) and does not call
`respondToApproval`/`addResult`/`resume` itself, even though it accepts them
as optional props. An exhaustive directory listing of `dist/primitives/`
also confirms there is no Dialog/Modal primitive of any kind.

**Net finding, reconfirmed by the actual build:** the DATA MODEL for
approval exists and should be reused (avoids inventing an ad hoc
approval-state shape), but the INTERACTIVE CHOOSER UI is 100% DIY — the
screen-builder must register a custom tool-UI component (via
`useAssistantToolUI`/`makeAssistantToolUI`) that reads `props.approval` +
`props.status` and drives its own `useInput`-based cursor loop, closely
mirroring Deus's real `PermissionModal.tsx` pattern (`cursorIndex` +
`PERMISSION_LIST_OPTIONS` + `onKeypress` forwarding), then calls
`props.respondToApproval({approved, optionId})` on Enter. Screen 1's build
is exactly this, and additionally surfaced the undocumented
`status: {type:"requires-action", reason:"interrupt"}` requirement that the
`.d.ts` alone did not reveal — a real integration effort should budget time
for this kind of runtime-only discovery, not just `.d.ts` reading.

## Overall adaptation-cost summary for @assistant-ui/react-ink as a tui-v2 foundation

**What it buys, verified across both screens:**
- A real, well-designed approval/tool-call data model (`ToolCallMessagePart`,
  `ToolApprovalOption`, `respondToApproval`) that maps cleanly onto Deus's
  existing 3-way permission decision, with zero adaptation of the data shape
  itself.
- A genuinely complete, dependency-light `DiffView` primitive that handles
  unified-diff parsing, intra-line highlighting, and gutter/stat rendering
  correctly out of the box, with no coupling to the chat/runtime machinery —
  usable standalone.

**What it costs, verified across both screens:**
- **A real, non-trivial packaging defect** in the current published version
  (`@assistant-ui/react-ink@0.0.33` / `@assistant-ui/core`'s react barrel):
  any import from the package's only public entry point statically pulls in
  an uninstalled optional peer dependency (`assistant-cloud`) and crashes at
  module load. This is not an edge case — it reproduced independently on
  both screens via two different code paths (a runtime-provider chat surface
  and a standalone non-chat primitive), meaning it will hit essentially any
  usage of this package version as published today. Production adoption
  needs either an upstream fix, an explicit `assistant-cloud` (dev)dependency
  pin, or a maintained stub — none of which currently exist as first-class,
  supported options.
- **Zero interactive-chooser UI is provided** for the approval flow — the
  entire keyboard-driven permission chooser had to be hand-built, closely
  mirroring the real `PermissionModal.tsx` implementation already in
  `tui-v2`. The library saves on data-model design but not on UI
  implementation effort for this specific screen.
- **An undocumented runtime invariant** (`status.type === "requires-action"`
  at the message level, not derivable from the `.d.ts` alone) that a real
  integration would need to discover the same way this prototype did — by
  running it and reading the library's own source/stack trace, not by
  reading published type declarations or docs.
- **Reliance on internal, non-public paths** for the diff workaround
  (`dist/primitives/diff/DiffView.js` via relative import) is brittle across
  version bumps if the packaging defect isn't fixed upstream or via the
  dependency-level stub first.

**Bottom line:** the library is a plausible foundation for the pieces it
actually owns (approval data shape, diff rendering primitive), but adopting
it as-is requires absorbing one real upstream packaging bug immediately
(non-optional if any part of the package is imported at all) and building
100% of the actual interactive chooser UI by hand — so the net effort saved
versus the fully hand-rolled `tui-v2` status quo is real but partial,
concentrated in the data-model and diff-rendering primitives rather than in
ready-to-use interactive screens.

## Round 3 — Claude Code design mimicry + feature exploration

Comparison round for LIA-493 (wayfinder map LIA-492): re-skin both screens to
the shared "Claude Code Design Language" spec (`cc-design-spec.md`'s Color
system / canonical `⏺` line-shape / OSC 8 file-path hyperlink / "do not box
every transcript line" rules), and answer one additional feature-exploration
question about a third `@assistant-ui/react-ink` surface
(`useRemoteThreadListRuntime`) this comparison hadn't touched yet. Built by
three parallel agents (permission screen, diff screen, spike), captured by a
fourth, reviewed by GPT-5.6-Sol (codex exec, read-only), and brought to SHIP
by this reconcile stage — which independently re-verified every claim below
against the actual code and re-ran everything rather than trusting the prior
stages' self-reports.

### What was redesigned, and why

**`src/permission-screen.tsx`** — replaced the round-2 bordered box with
generic `"yellow"`/`"cyan"`/`"green"`/`"red"` Ink color names and a `✓`/`✗`
glyph pair with: an explicit hex `tokens` object matching the spec verbatim;
a single stateful `⏺` bullet whose *color* (never a different glyph) carries
allow/deny state; a hand-rolled OSC 8 hyperlink for the file path (no
`terminal-link`-style package is installed and this prototype may not run
`npm install`, so `oscHyperlink()`/`pathHyperlink()` implement the same
`ESC ]8;;URL BEL label ESC ]8;; BEL` contract directly); numbered `1./2./3.`
options with a `›` cursor marker and an `accent.info` "(persists until
revoked)" note on "Always allow"; and collapsing the panel into a single
concise row once resolved, per the spec's "collapse the panel into a
concise tool-call row" rule. The library-owned data model (`approval` /
`ToolApprovalOption[]` / `respondToApproval` / the message-level
`requires-action` status) was preserved verbatim — only presentation moved.

**`src/diff-screen.tsx`** — replaced the round-2 `✓`/`✗`/`?` `statusGlyph()`
(an explicitly prohibited pattern per the spec: "do not switch between
unrelated success/error glyph families") with the same canonical `⏺`
bullet-carries-color convention; added the hex `tokens` object; split the
fixture's pre-formatted `"Edit(path)"` string into separate
`toolName`/`path`/`argsPreview` fields so the header and the path hyperlink
each get a real field instead of parsing a display string; and stopped
boxing every transcript line, reserving the rounded panel for the diff
itself (`DiffPanel`) while plain text results render unboxed
(`TextResult`).

**`src/thread-runtime-spike.tsx`** — new file, not a redesign. Answers the
spec's named feature-exploration target: `useRemoteThreadListRuntime` +
`RemoteThreadListAdapter` + per-thread `ThreadHistoryAdapter`, mounted for
real under Ink against a fixture reproducing Deus's actual daemon-side
shapes (cited by file:line in the file's header, verified first-hand this
session — see "Spike verification" below).

### Code-review outcome: REVISE → fixed → SHIP

GPT-5.6-Sol (codex exec, read-only, ran real commands — `git diff --check`,
`npm ls`, inspected `FINDINGS.md`/`package.json` — rather than reasoning
from the diff text alone) returned **REVISE** with 10 findings. This
reconcile stage independently re-read every flagged line before treating
the finding as real, then fixed what was fixable without violating this
repo's own data-privacy rules. Verified outcomes:

| # | Finding | Outcome |
|---|---|---|
| 1 | `permission-screen.tsx`: approval alone colored the row `semantic.success` even though the scripted adapter never executed `delete_file` | **FIXED.** The screen now performs a REAL `fs` deletion of a real scratch file (`/tmp/deus-scratch.log`) the instant a decision is approved, and colors the row from the actually-observed outcome (`executionOutcomes` map, keyed by `approval.id`) — `semantic.warning` if approved but no outcome is observed yet, never `semantic.success` from the decision alone. Verified live: `ls /tmp/deus-scratch.log` confirms the file is genuinely gone after approving, and the row's raw ANSI color is `38;2;120;140;93` (`semantic.success`) only in that case. |
| 2 | `diff-screen.tsx`: every diff routed through the same neutral panel regardless of `entry.status`, so a denied/error diff could render green additions with no "not applied" label | **FIXED.** `DiffPanel` now takes `status` and renders a bold "Proposed changes — not applied" label plus a `semantic.error`/`semantic.warning` border for any non-`success` status, guarded by a new `assertDiffPanelNeverImpliesSuccess()` regression check (mirrors the existing bullet-color guard). A new 4th fixture entry (a denied `Edit` carrying a real proposed patch) exercises this path — confirmed live in `captures/diff-screen-final.png`: red border, "Proposed changes — not applied" label, no implied success. |
| 3 | `thread-runtime-spike.tsx` scenario 4: a reconnect attempt that only ever gets a `"chat turn is already in progress"` error was graded and colored `PASS` | **FIXED.** Split into two independently-verdicted scenarios: **4a** ("original pending approval survives a disconnect") stays `PASS` — that fact is real and daemon-held. **4b** ("reconnect-to-in-flight-turn capability") is now graded `FAIL` — resuming an in-flight turn after reconnect genuinely does not exist in the transport, and is no longer rendered green. |
| 4 | Spec's Per-Candidate Application Plan asks to "test one real conversation group"; the spike uses a fully in-memory, synthetic fixture (`wa-family-group`) | **NOT FIXED — deliberately, after checking.** `store/messages.db` in this host's `deus-v2-mvp` checkout does contain real conversation groups with real personal message content. Seeding the fixture from that data (or driving the spike against a live daemon serving it) would put real personal chat content into a file this reconcile step commits and pushes to a shared branch — a direct violation of this repo's own rule ("Public repo changes must be user-agnostic. Personal fixtures/IDs stay in local paths.") and of PII-conservative defaults. The spike file now says this explicitly in a `RECONCILE note` instead of silently overclaiming realism it doesn't have; the underlying spec instruction remains genuinely unmet. |
| 5 | Several `PASS` results are fixture-only, not real library/runtime behavior, and don't say so | **FIXED (labeling).** Scenario names for #2 and #6 (and the new #4a) now say explicitly in-line what they exercise: "(fixture persists CLI turns; production does not yet)" for #2, "(fixture-level, mirrors PendingPermissionRegistry)" for #4a, "(fixture-level: exercises Deus's storeMessage/getMessagesSince semantics, not assistant-ui)" for #6. The underlying caveat text was already present in most `detail` strings; the fix makes it visible at the verdict-row level too, not just in the prose. |
| 6 | `permission-screen.tsx`: "Always allow" ends after one approval with no persisted-grant + auto-approved-second-request demonstration | **FIXED.** A second real user turn now triggers a SECOND `delete_file` request for a second scratch file that arrives already resolved (`approval.isAutomatic: true` — the library's own field for exactly this case, confirmed in `@assistant-ui/core`'s `message.d.ts`), with no interactive prompt. Verified live via tmux: after selecting "Always allow" and sending a second message, the resolved row reads `⏺ delete_file(/tmp/deus-scratch-2.log) — Always allow (deleted) — auto-approved: grant persists from earlier decision`, and `/tmp/deus-scratch-2.log` is genuinely deleted. |
| 7 | Resolved row reconstructed the path as plain text, losing the OSC 8 hyperlink | **FIXED.** `ResolvedRow` now renders the path through the same `<ToolPath/>` component as the unresolved panel. Verified live: the resolved row's raw terminal bytes still contain the `\x1b]8;;file://...\x07` OSC 8 sequence. |
| 8 | `diff-screen.tsx` still deep-imports an internal `dist` path instead of a pinned `assistant-cloud` dependency + public-barrel import | **Correctly graded lower severity by the reviewer** (the spec frames this as a preference, "prefer... over", not a requirement) — left as-is; `package.json`/`package-lock.json` changes are out of scope for a file-level redesign and the existing workaround still runs correctly. |
| 9 | `thread-runtime-spike.tsx:849`: `npx tsc --noEmit` genuinely fails (TS2345) — a literal string not in the `Verdict` union was used as a verdict value | **FIXED.** The literal is now the plain `"FAIL"` union member; the extra nuance ("spec's exact phrase does not hold end-to-end") already lived verbatim in the `detail` string and is unchanged. `npx tsc --noEmit -p .` is clean across all three files after this reconcile pass (re-verified, see below). |
| 10 | `FINDINGS.md` still described the obsolete round-2 glyph implementation and didn't document round-3's visuals or the spike | **FIXED** — this section. |

Verified after fixes: `npx tsc --noEmit -p .` exits clean with **zero
errors** across `permission-screen.tsx`, `diff-screen.tsx`, and
`thread-runtime-spike.tsx` (re-run by this reconcile stage, not assumed from
the build stage's self-report — the build/capture stages had in fact
disagreed with each other on this exact point, which is why it needed
re-checking rather than trusting either).

### Captures (re-recorded after the fixes above, all live-verified)

The round-2 build stage's original captures were recorded against the
pre-fix code and are no longer an accurate record of current behavior, so
this reconcile stage re-recorded all of them (same tmux + `asciinema
--headless --window-size` + `agg` + `PIL.Image.seek()` method as the
capture stage, `ffmpeg` still untouched):

- `captures/permission-unresolved.png`, `captures/permission-allow-once.{cast,gif}`,
  `captures/permission-resolved-allow-once.png` — "Allow once" scenario, now showing
  `(deleted)` from a real filesystem deletion.
- `captures/permission-always-allow.{cast,gif}`, `captures/permission-resolved-always-allow.png`
  — extended to a full two-turn recording: first approval, then a second user message
  triggering the new auto-approved persisted-grant request (finding #6).
- `captures/permission-deny.{cast,gif}`, `captures/permission-resolved-deny.png` —
  unchanged in substance (deny never executes) but re-recorded for consistency.
- `captures/diff-screen.{cast,gif}`, `captures/diff-screen-final.png` — now shows
  all 4 fixture entries including the new denied-diff "Proposed changes — not
  applied" panel (finding #2).
- `captures/thread-runtime-spike.{cast,gif}`, `captures/thread-runtime-spike-final.png`
  — shows the split 4a/4b scenarios and the corrected #5/#6 verdicts/labels.

The pre-round-3 files (`frame-check.png`, `frame-last.png`, `frame-mid.png`,
`permission-flow.cast`, `permission-flow.gif`) are untouched, already
git-tracked from an earlier round, and were correctly left alone (per the
capture stage's own note) rather than mistaken for current evidence.

### Spike: verified answer to the feature-exploration question

The spec's question, verbatim: *"Can assistant-ui's thread/history runtime
serve as a client-side projection over Deus's daemon-owned sessions without
becoming a second source of truth?"*

This reconcile stage re-read `src/thread-runtime-spike.tsx` end to end
(not just the build agent's self-report) and re-ran it (`npx tsx
src/thread-runtime-spike.tsx`, exit 0, clean stderr, no
`Unhandled`/`Cannot`/`TypeError` output) after applying the fixes above.
The scored scenarios now come out **5/7 PASS** (was reported as "5/6" before
the finding-#3 fix split scenario 4 into 4a+4b): scenarios 1, 2, 3, 4a, and 6
PASS; 4b and 5 FAIL.

**Verified answer: PARTIALLY, and more narrowly than the build agent's own
self-report implied before this reconcile pass.** The mechanism, confirmed
by re-reading the code (not just the prose):

- **Real win (scenario 3, unconditionally verified):** a message written
  directly to the daemon's `messages` table by a channel bridge (WhatsApp/
  Telegram) while no TUI is attached at all is picked up cleanly on the next
  `ThreadHistoryAdapter.load()`, with zero client involvement. This is
  the one scenario that depends *only* on data the daemon already owns and
  writes independently — it genuinely satisfies "no second source of truth"
  for that slice.
- **Conditional win, now labeled as such (scenario 2):** CLI-turn restart
  recovery only works because this spike's *own* fixture writes CLI-turn
  messages into the messages-shaped store — production `deus-native-chat.ts`
  (read end-to-end) never does this; only an opaque `resume_cursor`
  persists today. A real integration would need to add that write path.
- **Two confirmed, unconditional gaps (scenarios 4b and 5, now correctly
  graded FAIL rather than PASS/ambiguous):** there is no "reattach to an
  in-flight stream" API anywhere in `deus-native-chat-server.ts` — a
  reconnecting client only ever gets an "already in progress" error — so
  "approval resolution followed by resumed streaming" does not hold for a
  genuinely disconnected+reconnected client; the daemon-side approval
  resolves and the operation completes internally, but the reply is
  unrecoverable through this transport shape (confirmed by a follow-up
  restart: the reply never makes it into persisted history either, because
  the `ChatModelAdapter` generator that would append it is permanently
  stuck).
- **Fixture caveat that limits how much scenario 1/2/6 prove (see finding
  #4/#5 above):** the daemon side is a structurally-faithful but synthetic,
  in-memory stand-in, not a live daemon or a real conversation group — real
  personal message data exists on this host (`store/messages.db`) but using
  it here would violate this repo's own data-privacy rules for a pushed
  branch, so it was deliberately not used. The spec's literal "test one real
  group" instruction is genuinely unmet, not silently satisfied.

**Net for the adoption gate:** the runtime can cleanly ingest daemon state
and out-of-band channel updates (the one unconditionally-verified win) —
but it does *not* clear the gate for the CLI-native-chat turn/approval
slice specifically, both because today's Deus has no durable store for CLI
turns to project (a gap in Deus, not the library) and because the transport
has no reconnect-to-in-flight-stream capability (also a gap in Deus, not
the library) — `assistant-ui`'s runtime does what it's asked to with
whatever data it's given; it cannot manufacture durability or
resumability Deus's own transport doesn't provide. Recommendation
unchanged from the build stage's original conclusion, now on firmer
footing: adopt `useRemoteThreadListRuntime` only as a projection over
already-durable, already-multi-writer-safe daemon state (the WhatsApp/
Telegram `messages` table), not as the vehicle for CLI-turn history or
approval-resume, unless Deus first adds its own durable CLI-turn transcript
and a stream-reattach mechanism.

## Round 4 — full Claude Code app-shell mimicry (`src/full-shell.tsx`)

Every previous round exercised one screen or one mechanism in isolation
(permission prompt alone, diff rendering alone, the runtime/history spike
alone). This round composes all of it into a single cohesive, runnable Ink
app that hosts one real, scripted-but-live multi-turn session — the point
being to see whether the pieces actually cohere into a believable Claude
Code-shaped shell, not just whether each piece works on its own.

**What was composed** (`src/full-shell.tsx`, 948 lines): header/status bar
(project id + idle/working/awaiting-approval indicator via `useAuiState`) →
rotating-gerund spinner (`ink-spinner`, only while `thread.isRunning`) →
multi-turn transcript with canonical `⏺ ToolName(args)` bullets and real
chunk-by-chunk streamed assistant text → a real read-only `Bash` tool call
with a genuine result → a `delete_file` tool-call that genuinely interrupts
the live flow mid-conversation via the library's real approval data model
(`ToolCallMessagePart.approval` / `respondToApproval`), rendering an inline
permission panel inside the live transcript (not a standalone screen) →
resolving it (approve or deny) collapses it into a resolved `⏺` row and
auto-resumes the **same** turn (no fake second user message), using message
status `reason:"tool-calls"` so `respondToToolApproval`'s `shouldContinue`
check re-invokes the adapter — a mechanism found only by reading
`@assistant-ui/core`'s actual runtime source, not the docs → the resumed
step runs an `Edit` tool-call rendering a real diff (`DiffView`, reused from
`diff-screen.tsx`'s `DiffPanel` pattern) → a second user turn that runs a
second real `Bash` check whose result genuinely reflects the outcome of the
earlier delete/deny decision → footer `Tasks x/3` pills that progress from
observed fixture state, closing at 3/3.

Two real bugs were found only by running the app live in tmux, not by
reading or typechecking it: (1) calling `props.addResult` both before and
after `respondToApproval` on a still-pending approval double-satisfies the
library's `shouldContinue` gate and crashes with a synchronous re-entrant
"run already in progress" error — fixed by tracking the real deletion
outcome in a plain `Map` instead, mirroring `permission-screen.tsx`'s
already-proven approach; (2) the footer's "Clean up scratch file" task pill
never reached "done" because `delete_file` deliberately never receives a
`result` — fixed with a dedicated approval-based task-status check. A
third, UX-only bug was also found live: the composer's own `useInput`
stayed active during the permission chooser (the library does no focus
management), so keystrokes meant for the chooser leaked into the composer
text buffer — fixed by swapping the real composer for a muted placeholder
while a decision is pending.

**Capture.** One continuous `asciinema rec` inside a `120x40` tmux pane
(wider than the usual `100x30` — this shell's diff panel and permission
panel need the extra columns/rows to render without clipping), rendered to
gif via `agg`. Saved at
`proto/assistant-ui-demo/captures/full-shell.cast` /
`captures/full-shell.gif` (~55s, 547 recorded events, 112 gif frames),
with four still frames pulled via Python PIL (ffmpeg remains broken on
this host, confirmed again this round) at the moments that matter:
`full-shell-turn1-streaming.png` (spinner + streaming reply + `Tasks 0/3`),
`full-shell-permission.png` (inline permission panel mid-interrupt,
composer swapped for the muted placeholder, header reading "Awaiting
approval"), `full-shell-diff.png` (resolved `delete_file` row, resumed
turn, `Edit` diff panel, `Tasks 2/3`), and `full-shell-final.png` (second
user turn, second `Bash` check confirming the cleanup, `Tasks 3/3`, session
closed). The recording was verified in place — same session, same file — no
separate "capture attempt" was discarded.

**Honest note on full-shell composition vs. isolated pieces.** The library
supported composing these elements *structurally* without friction: each
screen built in earlier rounds (permission panel, diff panel, spinner,
footer pills) dropped into one shared `AssistantRuntimeProvider` /
`ThreadPrimitive` tree with no redesign needed, and the one genuinely
non-obvious integration point — resuming a tool-call turn after an inline
approval without faking a second user message — is exposed by the library's
own primitives (`reason:"tool-calls"` message status) once you go read the
runtime source, not a workaround bolted on top. That is a real point in the
library's favor: it does not fight you when you try to make the pieces
share one flow. What full composition adds that isolated screens hide,
though, is exactly the two state-management bugs above — both are races
between "who owns marking a tool call as resolved" (`addResult` vs.
`respondToApproval`) that only manifest once a real interrupt-then-resume
sequence runs inside a live multi-turn thread; neither bug was visible, or
even possible to hit, in the single-screen permission/diff demos, because
those never resumed a turn programmatically after approval. Net for the
adoption decision: the library's primitives compose cleanly at the
type/API level, but a production integration must own the same
resolved-state bookkeeping this file had to add by hand (a small `Map`,
not a novel abstraction) — that cost is real but bounded, and is now
demonstrated rather than assumed.

## Round 5 — pushed to the library's real limits (`src/full-shell.tsx`)

Round 4 composed the pieces already built in rounds 1–3 into one coherent
shell. This round went the other direction: it deliberately reached for
`@assistant-ui/react-ink` export-surface that no earlier round had touched
at all — `LiveChecklist`/`ChecklistPrimitive`, `MessagePrimitive.Parts` +
`ReasoningGroupComponent`, and `useNotification` — to see whether the
library's *unused* surface holds up as well as the parts already proven,
and whether a hand-rolled fixture piece (the footer's `Tasks x/3` string)
can be swapped for the library's real equivalent without losing fidelity.
The sibling build agent's self-report was verified firsthand in this
session, independently of its claims, before any of it was trusted:

- **Package surface — verified real, not guessed.** `grep`ing
  `node_modules/@assistant-ui/react-ink/dist/index.d.ts` confirms
  `LiveChecklist`, `ChecklistItemData`, `ChecklistItemStatus`,
  `ReasoningGroupComponent`, `ReasoningMessagePartProps`, `useNotification`,
  `ringBell`, and `sendOSCNotification` are all genuine named exports of the
  installed `0.0.33` package, not fixture-local shims. Reading the compiled
  source under `dist/primitives/checklist/{LiveChecklist,ChecklistItem,
  ChecklistProgress}.js` confirms `ChecklistItem` renders through a real
  `ink-spinner` while `status:"running"`, real `□`/`■`/`x` glyphs otherwise,
  and `ChecklistProgress` computes a genuine `n/total done` line by counting
  `complete`/`error` items — none of this is fixture-drawn text. Reading
  `dist/hooks/useNotification.js` confirms the documented zero-config
  default (`ringBell()` + `sendOSCNotification()` on a `task-complete`
  transition) is exactly what fires with no options passed, matching the
  claim.
- **`tsc --noEmit`: clean, exit 0** — re-run directly in this session, not
  taken on the sibling's word.
- **Diff scope: matches self-report.** `git diff --stat` on
  `src/full-shell.tsx` alone (`213 insertions(+), 24 deletions(-)`); no other
  file touched.
- **Live capture — driven with real keystrokes, not scripted props.** A
  fresh `120x40` tmux pane ran `asciinema rec -c 'npx tsx src/full-shell.tsx'
  captures/limits-push.cast`. Both user turns were sent via literal
  `tmux send-keys -l "<text>"` + a separate `Enter`, and the permission
  choice was sent the same way (`-l "1"` + `Enter` for "Allow once") — the
  same mechanism a human typing at the keyboard would produce, not a
  programmatic `thread.append()`/prop injection. Observed directly in the
  live pane, in order: a bordered "✻ Thinking…" reasoning block streamed in
  before any tool call, correctly flipping to "✻ Thought" once settled; a
  real `Bash` existence check; the inline permission panel (`Permission
  required` / `1. Allow once` / `2. Always allow` / `3. Deny`) with the
  composer genuinely swapped for the muted "Resolve the permission prompt
  above to continue…" placeholder; after sending `"1"` + Enter, the
  `delete_file` row collapsed to a resolved `⏺ delete_file(...) — Allow once
  (deleted)` and the turn auto-resumed into a real `Edit` diff panel — with
  **no second user message needed**, confirming round 4's `reason:
  "tool-calls"` resume mechanism still holds under round 5's changes. The
  `Tasks` footer, now a genuine `<LiveChecklist>`, advanced `0/3 done` → (a
  live spinner glyph on "Clean up scratch file" while pending) → `2/3 done`
  (real green `■` glyphs) after the first turn, and `3/3 done` after typing
  a second real message ("Now verify /tmp is clean") that triggered a real
  second `Bash` check. `tmux list-windows -F "bell=#{window_bell_flag}"`
  read `bell=1` immediately after the first turn's completion, confirming a
  genuine terminal BEL byte reached the pane — not merely that
  `useNotification()` was called, that its effect actually landed on the
  terminal.
- **No resize claim in this round** — round 5's diff adds no resize
  handling and none was claimed in the self-report, so step 4's "resize
  mid-recording" check (used in round 4) does not apply here; skipped
  correctly rather than fabricated.
- **One discrepancy from the self-report, worth naming precisely:** the
  self-report's item 2 (`ComposerPrimitive.Input`/`TextInput`) describes a
  *negative* finding — it says round 4 already wired real live typing and
  round 5 found nothing left to change there. That is accurate (confirmed
  independently by reading `ComposerInput.js` and by the fact that both
  user turns in this session's capture were driven by literal
  `tmux send-keys`, landing correctly), but it means round 5 shipped only
  three *new* library surfaces (`LiveChecklist`, the reasoning group, and
  `useNotification`), not four — the fourth "item" is a verified absence of
  work needed, not a new capability demoed. Framing this as a discrepancy
  rather than silently accepting the self-report's four-item count matters
  for an honest tally of what this round actually added.

**Capture.** `captures/limits-push.cast` (real asciinema recording, `120x40`,
~19.6s, 1,321 recorded events — not a static render) and
`captures/limits-push.gif` (agg-rendered, 217 frames). Four still frames
pulled via Python PIL with proper RGBA frame compositing (a first naive
attempt using `ImageSequence.Iterator` without per-frame compositing
silently produced four byte-identical stills — agg's animated-gif frames
are partial deltas, not fully redrawn each time, so pasting each decoded
frame onto a persistent canvas is required or every "different" index pick
collapses to the same image; caught by `md5`-comparing the four intended
stills and finding them identical before trusting any of them, then fixed
by re-extracting all 217 frames properly-composited and hand-picking exact
indices off a labeled contact sheet rather than guessing proportional
offsets):
`limits-push-reasoning.png` (frame 15 — bordered "Thinking…" block
streaming, `Tasks 0/3 done`), `limits-push-permission.png` (frame 60 — the
full inline "Permission required" panel with all three options, composer
swapped for the placeholder, a live `\` spinner glyph on the pending
"Clean up scratch file" row), `limits-push-checklist2of3.png` (frame 190 —
resolved `delete_file` row, resumed turn's `Edit` diff panel, `Tasks 2/3
done` with two real green `■` items, and the second user message
"Now verify /tmp is clean" already visible as genuinely-typed composer
text, captured mid-keystroke), and `limits-push-final3of3.png` (frame
214 — second turn's `Bash` verify result, closing message, `Tasks 3/3
done` with all three items green `■`). Each frame was individually
viewed and its content matched against its filename before being kept.

**Honest final take, after five rounds pushing this library as far as it
reasonably goes for a Claude-Code-shaped TUI.** `@assistant-ui/react-ink`
gets closer to a genuine Claude Code experience than any hand-rolled Ink
approach would justify building from scratch, and round 5 strengthens that
conclusion rather than complicating it: three previously-unused, real
library primitives (`LiveChecklist`, message-part grouping for reasoning,
`useNotification`) dropped into an already-composed shell with no structural
rework — swapping a hand-drawn `Tasks 2/3` string for `<LiveChecklist>` was
a ~15-line diff, not a redesign, and it bought a real progress line, real
status glyphs, and a real spinner for free. The reasoning-group swap
required understanding one non-obvious distinction (`.Content` has no
grouping concept, `.Parts` does) but did not require touching how
Bash/Edit/delete_file already rendered — confirmed, not assumed, by reading
the shared `useAssistantToolUI` registry both primitives resolve through.
`useNotification`'s zero-config default produced a real terminal BEL,
observed via `tmux`'s own bell-flag, not inferred from the hook being
called. None of this is packaged as fake polish: every glyph, spinner,
progress count, and BEL traced back to genuine, observed state — the same
bar every earlier round held itself to.

What this round does *not* change about the adoption picture: the library
still gives you compositional building blocks for a chat-shaped TUI, not a
finished Claude Code clone — every visual convention specific to Claude
Code itself (the `⏺` bullet vocabulary, the exact header/footer layout, the
inline-interrupt-then-resume approval flow) was fixture code written by
this prototype, not something `@assistant-ui/react-ink` ships out of the
box. Round 4's two real state-management bugs (the `addResult`/
`respondToApproval` double-satisfy race, the `delete_file` task-status gap)
remain the standing evidence that a production integration owns real
bookkeeping the library does not do for you. Pushed all the way to its
current real limits — five rounds, every claim independently verified
against source and against a live terminal, not against documentation or
self-report — this library is a genuinely strong foundation to build a
Claude-Code-shaped shell *on top of*, not a drop-in replacement for one.
That was true after round 4 and remains true after deliberately trying to
find where it breaks in round 5; nothing in this round's verification
surfaced a reason to revise it.
