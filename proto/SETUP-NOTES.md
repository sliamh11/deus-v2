# LIA-496 — S0 Setup Notes

Worktree: `.claude/worktrees/lia496-production-ui-spike` (branch `lia496-production-ui-spike`,
branched from `origin/main` @ `51a2359`).

**Freshness check** (`git fetch origin` + `git diff --stat HEAD origin/main` from the main repo):
`origin/main` has moved 4 files ahead since the worktree was branched (`.claude/wardens/{code-
review,plan-review}-rules.md`, `docs/agent-agnostic-debt.md`, `patterns/documentation.md`) — all
doc/policy files, nothing under `proto/` or touching this spike. Non-blocking for this stage.

## 1–5. Workspace scaffold

`proto/package.json` — npm workspaces `["shared", "web-app", "ink-app"]`.

- `shared/package.json` (`@lia496/shared`) — deps: `@assistant-ui/core@^0.3.0`,
  `assistant-stream@^0.3.29`, `shiki@^4.3.1` only. No react/react-dom/ink/react-ink.
- `web-app/package.json` — Vite + React 19 + `@assistant-ui/react@0.15.0` +
  `@assistant-ui/react-markdown@^0.14.8`.
- `ink-app/package.json` — `@assistant-ui/react-ink@^0.0.35` + `ink@^6` + `react@^19` +
  **`assistant-cloud@^0.1.37` as a real dependency** (LIA-495 fix: it's a genuine published npm
  package `@assistant-ui/core` lists as an *optional* peer dep, which npm skips on install — no
  `git add -f` stub).

## 6. Install + dedupe

`npm install` at the workspace root succeeded (270 packages, 0 vulnerabilities). `npm ls
@assistant-ui/core` and `npm ls assistant-cloud` confirm a **single hoisted version each**:
`@assistant-ui/core@0.3.0` and `assistant-cloud@0.1.37`, both `deduped` under `web-app` and
`ink-app` and resolved directly by `@lia496/shared`. `@assistant-ui/react-ink@0.0.35` declaring
`@assistant-ui/core@^0.3.0`/`@assistant-ui/store@^0.3.0` (matching `@assistant-ui/react@0.15.0`'s
own pins) is what makes this dedupe succeed where `0.0.33` would not have.

**Result: `sharedPackageDedupeSucceeded = true`.** `shared/` can be a real single package both
apps import — no fallback to per-app copies + parity-diff script needed.

## 7. ink-markdown compat probe (informational only)

Installed `ink-markdown@1.0.4` standalone (`npm install --no-save`, not added to `ink-app/
package.json`) to check compatibility with `ink@6`/`react@19`. `npm view` peer deps are
permissive (`ink: >=2.0.0`, `react: >=16.8.0`) and the install itself completed with no `ERESOLVE`
conflict.

At runtime it fails. `ink-app/scratch-probe` (temporary, removed after the probe; `npm install`
re-run afterward confirmed no lockfile/node_modules pollution — `npm ls` shows only the intended
dependency set) reproduced:

```
Error: Transform failed with 1 error:
node_modules/yoga-layout/dist/src/index.js:13:26: ERROR: Top-level await is currently not
supported with the "cjs" output format
```

Root cause, confirmed by reading `node_modules/ink-markdown/build/*.js` directly: `ink-markdown`'s
published build is plain CommonJS (`"use strict"`, `require("ink")`, `require("marked-terminal")`
etc.), not ESM. Requiring it forces `ink` — and transitively `yoga-layout`, which is ESM-only and
uses a top-level `await` — through a CJS transform, which esbuild/tsx correctly rejects. Isolated
this as the specific cause: a bare `ink`+`react` render (no `ink-markdown` import) runs fine under
the same `tsx` in this workspace, and importing `marked-terminal` alone (ink-markdown's renderer
dependency) also succeeds — only importing `ink-markdown` itself, which pulls in `ink` via
`require()`, triggers the failure.

**Conclusion: `ink-markdown@1.0.4` is not usable as-is against `ink@6`.** This does not block the
plan — Ink markdown was always going to be a small hand-rolled subset renderer (paragraphs, bold/
italic, inline code, lists, headings), never a dependency on this package. `ink-markdown` was not
added to `ink-app/package.json`.

## 8. `useCloudThreadListAdapter` history-provider wiring

Read `node_modules/@assistant-ui/core/src/react/runtimes/cloud/useCloudThreadListAdapter.tsx`
(source, not just the compiled `.js`) directly.

Mechanism: `useCloudThreadListAdapter` returns a `RemoteThreadListAdapter` whose
`unstable_Provider` is a memoized `FC<PropsWithChildren>` (`Provider`, defined via `useCallback`
with an empty dep array — stable identity across renders). Inside `Provider`, it calls
`useAssistantCloudThreadHistoryAdapter({ get current() { return
adapterRef.current.cloud ?? autoCloud!; } })` to build the per-thread `history` adapter, plus a
`CloudFileAttachmentAdapter` for `attachments`, memoizes both into an `adapters` object, and wraps
`children` in `<RuntimeAdapterProvider adapters={adapters}>`. This is how `history` reaches the
currently-active thread: `unstable_Provider` is mounted around the active thread's subtree by the
remote-thread-list runtime, and `RuntimeAdapterProvider` injects `history`/`attachments` into
context for that thread only — a fresh `Provider` instance/context per active thread, not a
global singleton. The adapter's own doc comment on `unstable_Provider` (`types.ts:47-57`) is
explicit: **the Provider must render `children` on its first commit** — no loading state, no
Suspense boundary, no `useEffect`-gated render before children appear, or downstream consumers
lose thread context. `list`/`initialize`/`rename`/`archive`/`unarchive`/`delete`/`generateTitle`/
`fetch` are the plain data-adapter methods (cloud-call implementations shown for reference; ours
will be in-memory `Map`-backed per the plan), independent of the Provider/history wiring.

For `shared/src/threadList.ts`'s `FixtureThreadListAdapter`, this means: implement `history` as a
per-thread `ThreadHistoryAdapter` (in-memory, keyed by thread ID) supplied via an
`unstable_Provider` of the same shape — a stable `FC` wrapping `children` in
`RuntimeAdapterProvider` with `{ history, attachments? }` — that renders `children` synchronously
on first commit, no deferred loading.

## 9. `ThreadListPrimitive` groupBy — confirmed

Read `node_modules/@assistant-ui/react/dist/primitives/threadList.d.ts`: exports are exactly
`Root`, `Items`, `ItemByIndex`, `LoadMore`, `New` — **no `groupBy`**. Confirms the plan's existing
finding; `Sidebar.tsx` needs manual Today/Yesterday filtering, not a primitive-provided grouping
mode.

## 10. RemoteThreadListAdapter non-optional members — confirmed

Read `node_modules/@assistant-ui/core/src/runtimes/remote-thread-list/types.ts`. Only
`updateCustom` and `unstable_Provider` are optional (`?`). `list`, `rename`, `archive`,
`unarchive`, `delete`, `initialize`, `generateTitle`, and `fetch` are all required.
`generateTitle(remoteId, unstable_messages): Promise<AssistantStream>` — confirms the plan's
stream-wrapper bridge is necessary, not a simplification opportunity.

## Design source

Copied `/Users/liam10play/.claude/jobs/d4c546e7/tmp/taste-pass-fable.html` to
`proto/design-source/taste-pass-fable.html` so the frozen `expected` values' source is diff-visible
and durable inside the worktree, not dependent on an external job-tmp path.

## Go/no-go

All stage-0 unknowns resolved, no blockers. `sharedPackageDedupeSucceeded = true` — S1 proceeds
with the real single-shared-package structure, not the per-app-copy fallback.
