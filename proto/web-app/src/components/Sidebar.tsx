// LIA-496 — Sidebar.tsx <- App.tsx (real primitives, not hand-rolled list
// state). ThreadListPrimitive.Root/New/ItemByIndex + ThreadListItemPrimitive
// per the S1 dispatch. Manual Today/Yesterday/Previous-7-days/Older
// grouping: confirmed by reading @assistant-ui/core's ThreadListPrimitive.
// Items types directly — Root/Items/ItemByIndex/LoadMore/New is the full
// export surface, no `groupBy` — so this component derives the buckets
// itself from `s.threadList.threadIds`/`threadItems` (real runtime state,
// not a snapshot) rather than the deprecated component-config grouping.
//
// WB2 (LIA-496 review-fix, batch 4/8) — five findings landed here:
//   W5 — always-armed delete / no overflow menu / hover reflow: replaced
//        the always-mounted archive+delete icon pair (shown/hidden via
//        `display:none`<->`flex`, which changed the row's layout width on
//        hover) with a single "..." overflow trigger that is ALWAYS
//        rendered (reserved-width slot; only its opacity toggles on
//        hover/focus/open, never its footprint) and a real confirm step
//        before delete actually fires.
//   W6 — real correctness bug: every non-today thread was bucketed
//        "Yesterday" regardless of true age (`isSameCalendarDay ? today :
//        yesterday`, a binary with no other branch). Replaced with a
//        truthful calendar-day-diff bucketing into Today / Yesterday /
//        Previous 7 days / Older.
//   W7 — desktop sidebar collapse: generalizes the existing sub-860px
//        drawer transform (`.s-side` off-canvas via `transform`) into a
//        real ≥861px width-collapse, toggled from a new "«" button here
//        and reversed via Thread.tsx's existing drawer-open button
//        (App.tsx wires both `drawerOpen` and `sidebarCollapsed`).
//   W8 — client-side thread-title search filter.
//   W9 — mobile drawer: selecting a thread now calls the real
//        `onCloseDrawer` (previously the drawer stayed open after
//        selection), plus a real focus-trap + `inert` background while
//        open (the `inert` half lives in App.tsx, which owns the sibling
//        `.s-main` region; the trap itself is local to this component).
//
// Also in scope this batch (flagged by WB1's own review/VERIFICATION.md as
// WB2's responsibility): the `.s-me` footer previously hardcoded a real
// personal display name — this repo is PUBLIC. Replaced with a generic
// placeholder ("You"), the client-side analogue of I5's
// `os.userInfo()`-style fix on the Ink side (no browser equivalent of
// `os.userInfo()`/`process.cwd()` exists client-side, so a literal generic
// placeholder is the right fix here, per the plan's own stated fallback).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
// Real hook, confirmed exported from `@assistant-ui/core/react`'s index.d.ts
// (`useThreadListItemDelete`) — same "core, not the DOM binding" import
// precedent Thread.tsx's own header comment already established for
// `useStreamingTiming`. Called directly (rather than rendering
// `ThreadListItemPrimitive.Delete` as the only way to trigger a delete) so
// the confirm step below is a real gate in front of the SAME runtime
// action, not a second parallel deletion path.
import { useThreadListItemDelete } from "@assistant-ui/core/react";
import { useHasListError } from "@lia496/shared";

// Code-review fix (LIA-496 REVISE round) — test hook for
// `captures/verify-s3.mjs` only, exposed here (rather than main.tsx)
// because `aui.threads.reload()` needs the real `useAui()` binding, which
// only exists inside the runtime provider's React tree. Never called by
// any in-app UI; see `main.tsx`'s own `__lia496_simulateNextListError`
// hook for the matching "force the failure" half of this test.
declare global {
  interface Window {
    __lia496_forceReload?: () => void;
  }
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// W6 — whole calendar-day difference between `at` and `now` (0 = today,
// 1 = yesterday, ...). Calendar-day based, not a raw ms/24h division, so a
// message from 11pm yesterday and one from 1am today are correctly 1 day
// apart even though they're only 2 hours apart in wall-clock time.
function calendarDaysAgo(at: Date, now: Date): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
}

type ThreadBuckets = {
  today: number[];
  yesterday: number[];
  previous7: number[];
  older: number[];
};

function useGroupedThreadIndices(query: string): ThreadBuckets {
  // `s.threads` (not `s.threadList`) — confirmed by reading
  // @assistant-ui/core's store/scope-registration.d.ts directly: the
  // registered ScopeRegistry key is "threads", backed by
  // store/scopes/threads.d.ts's ThreadsState (`threadIds: readonly
  // string[]`, `threadItems: readonly ThreadListItemState[]` — an ARRAY
  // parallel-keyed by each item's own `.id`, not a Record keyed by id like
  // the underlying RemoteThreadListThreadListRuntimeCore's `threadItems`
  // getter — that Record shape lives one layer down and isn't what
  // `useAuiState` exposes here).
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  return useMemo(() => {
    const now = new Date();
    const byId = new Map(threadItems.map((item) => [item.id, item] as const));
    const q = query.trim().toLowerCase();
    const buckets: ThreadBuckets = { today: [], yesterday: [], previous7: [], older: [] };
    threadIds.forEach((id, index) => {
      const item = byId.get(id);
      // W8 — client-side title filter. A thread with no resolved title
      // yet (brand-new, still showing the "New thread" fallback) only
      // matches an EMPTY query, matching what's actually visible on
      // screen for it.
      if (q && !(item?.title ?? "").toLowerCase().includes(q)) return;
      const at = item?.lastMessageAt ?? now;
      // W6 — real correctness bug fix: truthful Today / Yesterday /
      // Previous 7 days / Older buckets, replacing the previous
      // `isSameCalendarDay(at, now) ? today : yesterday` binary that
      // dumped every non-today thread into "Yesterday" no matter how old.
      const daysAgo = calendarDaysAgo(at, now);
      if (daysAgo <= 0) buckets.today.push(index);
      else if (daysAgo === 1) buckets.yesterday.push(index);
      else if (daysAgo <= 7) buckets.previous7.push(index);
      else buckets.older.push(index);
    });
    return buckets;
  }, [threadIds, threadItems, query]);
}

// W9 — lets the per-item `ThreadListItem` component (which has no prop
// channel of its own; it's invoked by `ThreadListPrimitive.ItemByIndex`
// via `components={{ ThreadListItem }}`, same constraint Thread.tsx's own
// `MessageTimingContext` header comment documents for the analogous
// per-message case) reach the drawer-close handler owned by `Sidebar`.
const SidebarActionsContext = createContext<{ onCloseDrawer: () => void }>({
  onCloseDrawer: () => {},
});

const ThreadListItem: FC = () => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title);
  const isActive = useAuiState((s) => s.threadListItem.id === s.threads.mainThreadId);
  const { onCloseDrawer } = useContext(SidebarActionsContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { delete: deleteThread } = useThreadListItemDelete();

  const startRename = () => {
    setDraft(title ?? "");
    setEditing(true);
  };

  const commitRename = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      void aui.threadListItem.rename(trimmed);
    }
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  };

  // W5 — real dismissal: outside click or Escape closes the overflow
  // menu, rather than a menu only ever closed by picking an option inside
  // it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeMenu is stable per render intent (resets local state only)
  }, [menuOpen]);

  return (
    <ThreadListItemPrimitive.Root asChild>
      <div className={`s-item-row${isActive ? " on" : ""}${menuOpen ? " menu-open" : ""}`}>
        {editing ? (
          // eslint-disable-next-line jsx-a11y/no-autofocus -- inline rename, same pattern as a native OS rename field
          <input
            className="s-item-rename"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
          />
        ) : (
          <ThreadListItemPrimitive.Trigger
            className="s-item"
            // W9 — close the mobile drawer on real selection. Harmless
            // no-op on desktop (`onCloseDrawer` just sets an already-false
            // `drawerOpen` to false again).
            onClick={onCloseDrawer}
            onDoubleClick={(e) => {
              e.preventDefault();
              startRename();
            }}
          >
            <ThreadListItemPrimitive.Title fallback="New thread" />
          </ThreadListItemPrimitive.Trigger>
        )}
        {!editing && (
          // W5 — always rendered (not conditionally mounted on hover), so
          // this slot's width is reserved at all times: hovering never
          // changes the row's layout width. The previous
          // `.s-item-actions` pair toggled `display:none` <-> `flex` on
          // hover, which *did* reflow the title text beside it — visible
          // proof this fixes it is in `captures/verify-wb2.mjs`
          // (bounding-box comparison across a hover cycle). Visibility
          // itself is hover/focus/open-driven via opacity + pointer-events
          // in theme.css, never `display`.
          <div className="s-item-menu" ref={menuRef}>
            <button
              type="button"
              className="s-item-menu-trigger"
              aria-label="Thread actions"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="s-item-menu-pop">
                {!confirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="s-item-menu-option"
                      onClick={() => {
                        closeMenu();
                        startRename();
                      }}
                    >
                      Rename
                    </button>
                    <ThreadListItemPrimitive.Archive className="s-item-menu-option" onClick={closeMenu}>
                      Archive
                    </ThreadListItemPrimitive.Archive>
                    <button
                      type="button"
                      className="s-item-menu-option s-item-menu-danger"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  // W5 — always-armed delete fix: a single click used to
                  // delete immediately with zero confirmation. This
                  // confirm step is the real gate — only clicking THIS
                  // "Delete" button (which calls the same
                  // `useThreadListItemDelete` runtime action
                  // `ThreadListItemPrimitive.Delete` itself uses
                  // internally) actually deletes the thread.
                  <div className="s-item-menu-confirm">
                    <span>Delete this thread?</span>
                    <div className="s-item-menu-confirm-row">
                      <button
                        type="button"
                        className="s-item-menu-option"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="s-item-menu-option s-item-menu-danger"
                        onClick={() => {
                          deleteThread();
                          closeMenu();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ThreadListItemPrimitive.Root>
  );
};

export const Sidebar: FC<{
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  collapsed: boolean;
  onCollapse: () => void;
}> = ({ drawerOpen, onCloseDrawer, collapsed, onCollapse }) => {
  const aui = useAui();
  const [query, setQuery] = useState("");
  const { today, yesterday, previous7, older } = useGroupedThreadIndices(query);
  // Code-review fix (LIA-496 REVISE round): `isEmpty` used to be the ONLY
  // signal driving the "No threads yet" message, so it rendered during the
  // real 250ms `list()` latency too (`isEmpty` is true before the list
  // resolves, same as after it resolves to zero threads) — an actively
  // wrong state, not just a missing spinner. `s.threads.isLoading` is a
  // real, library-owned reactive field (confirmed against
  // `store/scopes/threads.d.ts`'s `ThreadsState`) that this file simply
  // never read before. `hasListError` is NOT library-provided — see
  // `shared/src/listStatus.ts`'s header comment for why a genuine
  // list()-load error is otherwise unobservable through `useAuiState` at
  // all, and the tiny owned tracker that closes that gap.
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const hasListError = useHasListError();
  const hasAnyThreads = today.length + yesterday.length + previous7.length + older.length > 0;
  const isEmpty = !isLoading && !hasListError && !hasAnyThreads;
  const trimmedQuery = query.trim();

  useEffect(() => {
    window.__lia496_forceReload = () => void aui.threads.reload();
    return () => {
      delete window.__lia496_forceReload;
    };
  }, [aui]);

  // W9 — real focus-trap while the mobile drawer is open: focus moves
  // into the sidebar on open, Tab/Shift+Tab cycle within it, Escape closes
  // it, and focus returns to whatever triggered the open on close. (The
  // matching `inert` half — making the sibling `.s-main` region
  // unfocusable/non-interactive while the drawer covers it — is applied
  // in App.tsx, which owns that sibling; this component only owns its own
  // subtree.)
  const asideRef = useRef<HTMLElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      Array.from(aside.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => el.offsetParent !== null,
      );

    const first = getFocusable()[0];
    (first ?? aside).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseDrawer();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [drawerOpen, onCloseDrawer]);

  return (
    <ThreadListPrimitive.Root asChild>
      <aside
        ref={asideRef}
        tabIndex={-1}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? "Thread sidebar" : undefined}
        className={`s-side${drawerOpen ? " open" : ""}${collapsed ? " collapsed" : ""}`}
      >
        <div className="s-side-inner">
          <div className="s-brand">
            Deus
            <div className="s-brand-actions">
              {/* W7 — desktop collapse trigger (>=861px only, CSS-gated;
                  mirror of the mobile-only `.s-drawer-close` below). The
                  reverse action (expand) reuses Thread.tsx's existing
                  `.s-drawer-open` button, generalized in theme.css to also
                  show at desktop widths while collapsed — see that file's
                  header comment. */}
              <button className="s-collapse-btn" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar">
                «
              </button>
              <button className="s-drawer-close" onClick={onCloseDrawer} aria-label="Close sidebar">
                ×
              </button>
            </div>
          </div>
          <ThreadListPrimitive.New className="s-new">
            <span className="pl">+</span> New chat
          </ThreadListPrimitive.New>

          {/* W8 — client-side title filter, no backend/shared involvement. */}
          <input
            type="search"
            className="s-search"
            placeholder="Search threads…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search threads"
          />

          <SidebarActionsContext.Provider value={{ onCloseDrawer }}>
            {isLoading && <div className="s-side-loading">Loading threads…</div>}

            {hasListError && (
              <div className="s-side-error">
                Couldn't load threads.
                <button type="button" onClick={() => void aui.threads.reload()}>
                  Retry
                </button>
              </div>
            )}

            {!isLoading && !hasListError && today.length > 0 && (
              <>
                <div className="s-sec">Today</div>
                {today.map((index) => (
                  <ThreadListPrimitive.ItemByIndex key={index} index={index} components={{ ThreadListItem }} />
                ))}
                <div className="s-gap" />
              </>
            )}

            {!isLoading && !hasListError && yesterday.length > 0 && (
              <>
                <div className="s-sec">Yesterday</div>
                {yesterday.map((index) => (
                  <ThreadListPrimitive.ItemByIndex key={index} index={index} components={{ ThreadListItem }} />
                ))}
                <div className="s-gap" />
              </>
            )}

            {!isLoading && !hasListError && previous7.length > 0 && (
              <>
                <div className="s-sec">Previous 7 days</div>
                {previous7.map((index) => (
                  <ThreadListPrimitive.ItemByIndex key={index} index={index} components={{ ThreadListItem }} />
                ))}
                <div className="s-gap" />
              </>
            )}

            {!isLoading && !hasListError && older.length > 0 && (
              <>
                <div className="s-sec">Older</div>
                {older.map((index) => (
                  <ThreadListPrimitive.ItemByIndex key={index} index={index} components={{ ThreadListItem }} />
                ))}
              </>
            )}

            {isEmpty && (
              <div className="s-empty-list">
                {trimmedQuery ? `No threads match "${trimmedQuery}".` : "No threads yet — start one above."}
              </div>
            )}
          </SidebarActionsContext.Provider>

          <div className="s-me">
            <span className="s-ava">Y</span> You
          </div>
        </div>
      </aside>
    </ThreadListPrimitive.Root>
  );
};
