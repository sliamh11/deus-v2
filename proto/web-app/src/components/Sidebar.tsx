// LIA-496 — Sidebar.tsx <- App.tsx (real primitives, not hand-rolled list
// state). ThreadListPrimitive.Root/New/ItemByIndex + ThreadListItemPrimitive
// per the S1 dispatch. Manual Today/Yesterday grouping: confirmed by reading
// @assistant-ui/core's ThreadListPrimitive.Items types directly —
// Root/Items/ItemByIndex/LoadMore/New is the full export surface, no
// `groupBy` — so this component derives the two buckets itself from
// `s.threadList.threadIds`/`threadItems` (real runtime state, not a
// snapshot) rather than the deprecated component-config grouping.
import { useEffect, useMemo, useState, type FC } from "react";
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
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

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function useGroupedThreadIndices(): { today: number[]; yesterday: number[] } {
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
    const today: number[] = [];
    const yesterday: number[] = [];
    threadIds.forEach((id, index) => {
      const at = byId.get(id)?.lastMessageAt ?? now;
      (isSameCalendarDay(at, now) ? today : yesterday).push(index);
    });
    return { today, yesterday };
  }, [threadIds, threadItems]);
}

const ThreadListItem: FC = () => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title);
  const isActive = useAuiState((s) => s.threadListItem.id === s.threads.mainThreadId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

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

  return (
    <ThreadListItemPrimitive.Root asChild>
      <div className={`s-item-row${isActive ? " on" : ""}`}>
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
            onDoubleClick={(e) => {
              e.preventDefault();
              startRename();
            }}
          >
            <ThreadListItemPrimitive.Title fallback="New thread" />
          </ThreadListItemPrimitive.Trigger>
        )}
        {!editing && (
          <div className="s-item-actions">
            <ThreadListItemPrimitive.Archive className="s-item-action" title="Archive">
              archive
            </ThreadListItemPrimitive.Archive>
            <ThreadListItemPrimitive.Delete className="s-item-action" title="Delete">
              delete
            </ThreadListItemPrimitive.Delete>
          </div>
        )}
      </div>
    </ThreadListItemPrimitive.Root>
  );
};

export const Sidebar: FC<{ drawerOpen: boolean; onCloseDrawer: () => void }> = ({
  drawerOpen,
  onCloseDrawer,
}) => {
  const aui = useAui();
  const { today, yesterday } = useGroupedThreadIndices();
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
  const isEmpty = !isLoading && !hasListError && today.length === 0 && yesterday.length === 0;

  useEffect(() => {
    window.__lia496_forceReload = () => void aui.threads.reload();
    return () => {
      delete window.__lia496_forceReload;
    };
  }, [aui]);

  return (
    <ThreadListPrimitive.Root asChild>
      <aside className={`s-side${drawerOpen ? " open" : ""}`}>
        <div className="s-brand">
          Deus
          <button className="s-drawer-close" onClick={onCloseDrawer} aria-label="Close sidebar">
            ×
          </button>
        </div>
        <ThreadListPrimitive.New className="s-new">
          <span className="pl">+</span> New chat
        </ThreadListPrimitive.New>

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
          </>
        )}

        {isEmpty && <div className="s-empty-list">No threads yet — start one above.</div>}

        <div className="s-me">
          <span className="s-ava">L</span> Liam
        </div>
      </aside>
    </ThreadListPrimitive.Root>
  );
};
