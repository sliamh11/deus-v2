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
