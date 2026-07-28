// LIA-496 — ← App.tsx (confirm that link in App.tsx, not here).
// `ThreadListPrimitive` (react-ink exports the same namespace as web, but
// only `Root`/`Items`/`New` — no `ItemByIndex`/`LoadMore`, confirmed by
// reading node_modules/@assistant-ui/react-ink/dist/primitives/
// threadList.d.ts directly; matches SETUP-NOTES.md §9's finding). No
// `groupBy` either, so Today/Yesterday below is manual bucketing over
// `lastMessageAt` — but each ROW is still mounted through the real
// `ThreadListPrimitive.Items`'s `renderItem`, not a hand-rolled array map:
// `renderItem` runs inside `ThreadListItemByIndexProvider`'s real scope
// (confirmed by reading
// node_modules/@assistant-ui/react-ink/src/primitives/threadList/
// ThreadListItems.tsx directly), so `SidebarRow` below reads its own
// title/status/lastMessageAt/isMain via `useAuiState((s) =>
// s.threadListItem)` — genuinely scoped per-item state, not a snapshot
// index into a flat array.
//
// Keyboard model (no mouse/click affordances — this is Ink):
//   - `ctrl+n` — always active regardless of focus: `switchToNewThread()`
//     (the SAME call `ThreadListPrimitive.New` below fires via its own
//     Pressable when it has native focus).
//   - `tab` — Ink's own, genuinely-working focus manager: this component
//     registers one focus stop (`useFocus({id:"sidebar"})`, below) and
//     `Composer.tsx`'s `ComposerPrimitive.Input`/`TextInput` registers
//     another (plus `ThreadListPrimitive.New`'s own `Pressable`, a third).
//     Tab cycles all of them with no hand-rolled plumbing — **BUILD-stage
//     finding, corrected after a real misdiagnosis**: see App.tsx's own
//     header comment for the full trace of how an earlier version of this
//     file wrongly concluded Ink's native Tab-cycling was broken (it
//     isn't) and built a redundant, actively-conflicting App-level Tab
//     handler instead. That handler is gone; this component owns its own
//     `useFocus` again, verified working end-to-end by actually running
//     the app under a real tmux pty (Tab moves the highlight here, typing
//     in the composer afterward still works).
//   - `↑`/`↓`/`enter`/`d` — gated on this component's own `isFocused`
//     (from `useFocus`). Composer's `TextInput` never consumes `↑`/`↓` in
//     single-line mode (confirmed by reading `TextInput.tsx`:
//     `if (multiLine && key.upArrow)`), so those two are harmless to leave
//     always-active regardless of which pane is focused; `enter`/`d` ARE
//     gated, since Composer's own `enter` submits and a stray `d` would
//     otherwise land in the composer's text buffer while it has focus.
import { useEffect, useRef, useState, type FC } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { ThreadListPrimitive, useAui, useAuiState } from "@assistant-ui/react-ink";
import { theme } from "../theme";
import { markFreshDraft } from "../freshDraftTracker";

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const SidebarRow: FC<{ index: number; cursorIndex: number; sidebarFocused: boolean; showHeader: "today" | "yesterday" | undefined }> = ({
  index,
  cursorIndex,
  sidebarFocused,
  showHeader,
}) => {
  const item = useAuiState((s) => s.threadListItem);
  // The store-scope `ThreadListItemState` (`s.threadListItem`) has no
  // `isMain` field — that field only exists on the separate runtime-API
  // binding type (`@assistant-ui/core`'s `runtime/api/bindings.ts`), not
  // the zustand store shape `useAuiState` reads here. `s.threads
  // .mainThreadId` (confirmed present on `ThreadsState`) compared against
  // this row's own `.id` is the real equivalent.
  const isMain = useAuiState((s) => s.threads.mainThreadId === item.id);
  const highlighted = sidebarFocused && index === cursorIndex;

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Text color={theme.dim}>
          {"── "}
          {showHeader}
        </Text>
      ) : null}
      <Text color={isMain ? theme.amber : theme.dim} inverse={highlighted} wrap="truncate-end">
        {isMain ? "▸ " : "  "}
        {item.title ?? "(untitled)"}
      </Text>
    </Box>
  );
};

export const Sidebar: FC = () => {
  const { isFocused: focused } = useFocus({ id: "sidebar" });
  const aui = useAui();
  // Read-only snapshot used ONLY for day-bucket boundaries + cursor
  // wraparound math (things no primitive provides) — actual row mounting
  // below still goes through `ThreadListPrimitive.Items`.
  //
  // Code-review fix (LIA-496 REVISE round): this used to be
  // `useAuiState((s) => s.threads.threadItems).filter((item) => item.status
  // !== "new")` — `threadItems` is a KEYED LOOKUP whose iteration order
  // (`Object.values`) is object-key INSERTION order, not necessarily the
  // same order `ThreadListPrimitive.Items` actually renders in. Confirmed
  // by reading `ThreadListItems.js` directly: it maps over
  // `useAuiState((s) => s.threads.threadIds)` — a SEPARATE, explicitly
  // ORDERED array — not `threadItems`. The two only happened to agree
  // right after a fresh launch (BUILD-stage's own smoke test caught a
  // DIFFERENT index-space gap — the transient "new"-status draft thread —
  // and fixed that one with a status filter, but never checked ordering
  // once real interaction could reorder threads); this is what produced
  // this round's REVISE finding: once a thread's `lastMessageAt` changes
  // from being interacted with, `threadIds` reflects the new order but
  // `Object.keys(threadItems)`'s insertion order does not, so
  // `headerFor(index)` computed today/yesterday boundaries against the
  // WRONG row. Mapping `threadIds` (the exact array `.Items` iterates) to
  // its own items below makes this snapshot's index space match `.Items`'s
  // real one BY CONSTRUCTION, not by a status filter that only happened to
  // hold for the specific case it was written to fix. `threadIds` itself
  // never includes "new"-status drafts (confirmed by reading
  // `RemoteThreadListThreadListRuntimeCore.tsx`'s `_switchToNewThread`: a
  // draft's `threadData`/`threadIdMap` entries are added without ever
  // touching `threadIds`), so the old status filter is now redundant, not
  // just wrong-order — dropped entirely rather than kept as dead code.
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const items = threadIds
    .map((id) => threadItems.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const [cursor, setCursor] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  // Code-review fix (LIA-496 REVISE round) — see `freshDraftTracker.ts`'s
  // header comment for the full root-cause trace. `mainThreadId` here
  // (read reactively via `useAuiState`, the SAME `s.threads` scope
  // `SidebarRow`'s own `▸` marker above uses) is confirmed correct in
  // every live reproduction; an EARLIER version of this fix read
  // `aui.threads.getState().mainThreadId` IMPERATIVELY inside
  // `switchToNewThread()`'s `.then()` callback instead, which — running
  // outside a React render — was itself occasionally stale (same proxy
  // chain as the bug this works around), so `markFreshDraft` sometimes
  // fired with a STALE id and never marked the real new draft. Routing
  // through this `useEffect` instead means we only ever mark an id we
  // observed via the reliable reactive path.
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const awaitingFreshDraftRef = useRef(false);
  useEffect(() => {
    if (awaitingFreshDraftRef.current && mainThreadId) {
      markFreshDraft(mainThreadId);
      awaitingFreshDraftRef.current = false;
    }
  }, [mainThreadId]);

  const now = new Date();
  const headerFor = (index: number): "today" | "yesterday" | undefined => {
    const item = items[index];
    if (!item) return undefined;
    const isToday = item.lastMessageAt ? isSameCalendarDay(item.lastMessageAt, now) : true;
    const prev = items[index - 1];
    const prevIsToday = prev?.lastMessageAt ? isSameCalendarDay(prev.lastMessageAt, now) : true;
    if (index === 0) return isToday ? "today" : "yesterday";
    if (isToday !== prevIsToday) return isToday ? "today" : "yesterday";
    return undefined;
  };

  const highlightedId = items[cursor]?.id;

  useInput(
    (input, key) => {
      if (key.ctrl && input === "n") {
        // See the `useEffect` above (and `freshDraftTracker.ts`'s header
        // comment) for why marking happens there, reactively, rather than
        // imperatively off this call's own promise.
        awaitingFreshDraftRef.current = true;
        aui.threads.switchToNewThread();
        setPendingDeleteId(undefined);
        return;
      }

      if (!focused) return;

      if (pendingDeleteId) {
        if (input === "y") {
          aui.threads.item({ id: pendingDeleteId }).delete();
          setPendingDeleteId(undefined);
          setCursor((c) => Math.max(0, c - 1));
        } else if (input === "n" || key.escape) {
          setPendingDeleteId(undefined);
        }
        return;
      }

      if (key.upArrow) {
        setCursor((c) => (items.length === 0 ? 0 : (c - 1 + items.length) % items.length));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (items.length === 0 ? 0 : (c + 1) % items.length));
        return;
      }
      if (key.return) {
        if (highlightedId) aui.threads.switchToThread(highlightedId);
        return;
      }
      if (input === "d") {
        if (highlightedId) setPendingDeleteId(highlightedId);
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box
      flexDirection="column"
      width={34}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor={theme.line}
      backgroundColor={theme.side}
      paddingTop={1}
      paddingX={1}
    >
      {/* Code-review fix (LIA-496 REVISE round): `ThreadListPrimitive.Root`
          renders a plain `<Box {...boxProps}>` (confirmed by reading
          `ThreadListRoot.js` directly) — with no `flexDirection` prop
          passed, it fell back to Ink's own default, which is `"row"`
          (confirmed in `node_modules/ink/build/components/Box.js`), NOT
          `"column"` like the DOM. That put the "+ new session" row and the
          `.Items`-rendered rows below it as ROW-siblings instead of
          stacked, so they laid out side by side on the same terminal
          line — reproduced as the exact "+ new se── today" merge this
          finding named, on every fresh launch. `flexDirection="column"`
          here is the fix; every other `<Box>` in this file already sets
          it explicitly, this was the one omission. */}
      <ThreadListPrimitive.Root flexDirection="column">
        <Box marginBottom={1}>
          {/* `disabled` keeps this a real, mounted `ThreadListPrimitive.New`
              (still genuinely wired to `switchToNewThread` — Pressable's own
              `useFocus` still registers it, just deactivated) without
              adding a THIRD stop to the Tab cycle: Pressable's `useFocus
              ({isActive: !disabled})` marks it inactive, and Ink's own
              `findNextFocusable`/`findPreviousFocusable` skip inactive
              entries — confirmed by reading
              node_modules/ink/build/components/App.js directly. Keeps
              Tab cycling a clean two-way toggle between this sidebar and
              Composer.tsx's TextInput; `ctrl+n` (below) is the real
              keyboard path to the same action either way. */}
          <ThreadListPrimitive.New disabled>
            <Text color={theme.amber} wrap="truncate-end">
              + new session
            </Text>
          </ThreadListPrimitive.New>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <ThreadListPrimitive.Items
            renderItem={({ index }) => (
              <SidebarRow index={index} cursorIndex={cursor} sidebarFocused={focused} showHeader={headerFor(index)} />
            )}
          />
        </Box>
      </ThreadListPrimitive.Root>
      {pendingDeleteId ? (
        <Box marginTop={1}>
          <Text color={theme.err}>delete "{items.find((i) => i.id === pendingDeleteId)?.title}"? [y/n]</Text>
        </Box>
      ) : null}
      <Box marginTop={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={theme.line} paddingTop={1}>
        <Text color={focused ? theme.amber : theme.ink}>liam</Text>
        <Text color={theme.dim}> ~/deus{focused ? " · ↑/↓ enter d" : ""}</Text>
      </Box>
    </Box>
  );
};
