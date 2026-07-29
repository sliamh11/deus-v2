// LIA-496 — the 7 seeded thread records `FixtureThreadListAdapter` (see
// ../threadList.ts) loads its in-memory Map from at module init. Themed
// around this same tui-v2 work, per the S1 dispatch. `id` doubles as the
// `remoteId` used everywhere (thread list, history store, adapter
// lookup) and as the key into ./conversations.ts's `SCRIPTS` map — the
// single identifier a target needs to thread all three together.
//
// `lastMessageAt` offsets are relative to module-eval time (hours/days
// ago), not fixed calendar timestamps, so re-running the app always
// produces a sane Today/Yesterday/Previous-7-days/Older split for
// Sidebar.tsx's grouping (target-specific, not this module's job) without
// needing to hand-edit dates.
//
// WB2 sanctioned fixture change (LIA-496 review-fix, the ONLY logic/data
// change allowed in shared/ for this batch — see the plan's "Scope
// guardrails" section): `streaming-markdown-flicker`'s `lastMessageAt`
// below is moved from ~33 hours ago to ~9 days ago so the corrected
// truthful "Previous 7 days" / "Older" bucketing (Sidebar.tsx's W6 fix —
// every non-today thread used to be mislabeled "Yesterday" regardless of
// actual age) is visually demonstrable: with no thread older than ~33
// hours in the original set, the "Older" bucket could never render at
// all, honest or not. This is a data change, not a presentation value —
// `check-shared-purity.sh` stays green (fixtures/ is exempt).
export type SeedThread = {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: Date;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();
const hoursAgo = (h: number): Date => new Date(NOW - h * HOUR_MS);
const daysAgo = (d: number): Date => new Date(NOW - d * DAY_MS);

export const SEED_THREADS: readonly SeedThread[] = [
  // Today
  {
    id: "status-glyph-fix",
    title: "Status-glyph rendering fix",
    lastMessageAt: hoursAgo(1),
  },
  {
    id: "composer-shortcuts",
    title: "Composer keyboard shortcuts",
    lastMessageAt: hoursAgo(4),
  },
  // S2A (web) deviation, logged in web-app's build report and
  // shared/src/fixtures/conversations.ts's errorDemoScript comment: the S1
  // dispatch's own "Consuming call sites" section requires "the one
  // fixture thread scripted to throw from the adapter" for
  // ErrorState.tsx/ErrorPrimitive — no seeded thread did this yet. Routed
  // through one real shared-side edit (this entry + the matching SCRIPTS
  // entry) rather than a web-only fork, since ErrorState.tsx exists on
  // both targets and both need the same real fixture.
  {
    id: "theme-swap-crash",
    title: "Shiki theme swap crash",
    lastMessageAt: hoursAgo(2),
  },
  // Yesterday
  {
    id: "lia495-migration-spike",
    title: "LIA-495 migration spike",
    lastMessageAt: hoursAgo(27),
  },
  {
    id: "sidebar-layout-pass",
    title: "Sidebar layout pass",
    lastMessageAt: hoursAgo(29),
  },
  {
    id: "diff-panel-polish",
    title: "Diff panel polish",
    lastMessageAt: hoursAgo(31),
  },
  // WB2 sanctioned fixture change (see this file's header comment) — was
  // hoursAgo(33) ("Yesterday"); moved to ~9 days ago so the truthful
  // "Older" bucket has a real thread to render into.
  {
    id: "streaming-markdown-flicker",
    title: "Streaming markdown flicker",
    lastMessageAt: daysAgo(9),
  },
] as const;
