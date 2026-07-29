// LIA-496 — "Reading Room" (web). App.tsx wires
// AssistantRuntimeProvider(useRemoteThreadListRuntime({runtimeHook,
// adapter: fixtureThreadListAdapter})) around Sidebar + (Thread, Composer)
// as siblings, exactly per the S1 dispatch's Reading Room section.
//
// WB2 (LIA-496 review-fix, batch 4/8) — W7 + W9 wiring lives here:
//   W7 — `sidebarCollapsed` is the desktop-collapse counterpart to the
//        existing mobile-only `drawerOpen`: Sidebar.tsx's new "«" button
//        sets it true, Thread.tsx's existing drawer-open button (reused,
//        not duplicated — see that file's header comment) sets it false.
//        Both states are independent and safe to touch together: each
//        only has a visible effect within its own CSS media-query range
//        (`sidebarCollapsed` >=861px, `drawerOpen` <=860px), so
//        `openSidebar` below setting both is harmless, not a conflict.
//   W9 — `inert` on `.s-main` while the mobile drawer is open: real
//        background non-interactivity (not just a visual scrim), the
//        sibling half of Sidebar.tsx's own focus-trap fix (that file owns
//        the trap itself; this file owns making the OTHER sibling
//        non-interactive while the drawer covers it).
// `runtimeHook` mechanism, confirmed by reading
// node_modules/@assistant-ui/core/dist/react/runtimes/
// RemoteThreadListHookInstanceManager.js directly (not guessed): each
// active thread gets an `_OuterActiveThreadProvider` that mounts, in order,
// `ThreadListItemRuntimeProvider` -> the adapter's `unstable_Provider` ->
// `_RuntimeBinder` (which is where `runtimeHook` is actually called). So
// `runtimeHook`'s body runs INSIDE the `threadListItem` scope already
// registered for that thread — `useAui().threadListItem.getState()` here
// resolves to the CURRENT active thread's id/remoteId, the same mechanism
// shared/src/threadList.tsx's own `unstable_Provider` and history.ts's
// header comment document for history wiring. This is what lets each
// thread get its OWN memoized fixture adapter (shared/src/adapter.ts's
// `getFixtureAdapter(threadId)` is keyed + memoized per threadId already).
import { useState, type FC } from "react";
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
  useLocalRuntime,
  useAui,
} from "@assistant-ui/react";
import { fixtureThreadListAdapter, getFixtureAdapter } from "@lia496/shared";
import { Sidebar } from "./components/Sidebar";
import { Thread } from "./components/Thread";
import { Composer } from "./components/Composer";

function useReadingRoomThreadRuntime() {
  const aui = useAui();
  const item = aui.threadListItem.getState();
  // A freshly-created thread has no remoteId yet (still optimistic, per
  // RemoteThreadListOptions.onThreadIdChange's own doc comment) — fall back
  // to the local `id`, which shared/src/adapter.ts's per-thread Map handles
  // the same way (any string key works; genericNewThreadScript is the
  // fallback for ids fixtures/conversations.ts's SCRIPTS doesn't know).
  const threadId = item.remoteId ?? item.id;
  return useLocalRuntime(getFixtureAdapter(threadId));
}

const App: FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useReadingRoomThreadRuntime,
    adapter: fixtureThreadListAdapter,
  });

  // W7 — Thread.tsx's single toggle button opens the mobile drawer AND
  // expands a collapsed desktop sidebar; only one of the two has any
  // visible effect at a given viewport width (CSS media-query gated), so
  // setting both here is correct, not redundant.
  const openSidebar = () => {
    setDrawerOpen(true);
    setSidebarCollapsed(false);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="rr-app">
        <div
          className={`rr-scrim${drawerOpen ? " open" : ""}`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
        <Sidebar
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          collapsed={sidebarCollapsed}
          onCollapse={() => setSidebarCollapsed(true)}
        />
        {/* W9 — real background non-interactivity while the mobile drawer
            overlays this region (not just a visual scrim): `inert` removes
            `.s-main` from the accessibility tree and blocks pointer/focus
            interaction with it entirely. React 19 supports `inert` as a
            native boolean DOM prop (confirmed: this repo's `react`/
            `react-dom` are ^19.2.7). `undefined` (not `false`) when
            inactive so the attribute is genuinely absent, matching how the
            real DOM `inert` attribute works (presence, not value, is what
            counts). */}
        <div className={`s-main${sidebarCollapsed ? " sidebar-collapsed" : ""}`} inert={drawerOpen || undefined}>
          <Thread onOpenDrawer={openSidebar} />
          <Composer />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
};

export default App;
