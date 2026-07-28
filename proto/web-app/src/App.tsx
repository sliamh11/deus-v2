// LIA-496 — "Reading Room" (web). App.tsx wires
// AssistantRuntimeProvider(useRemoteThreadListRuntime({runtimeHook,
// adapter: fixtureThreadListAdapter})) around Sidebar + (Thread, Composer)
// as siblings, exactly per the S1 dispatch's Reading Room section.
//
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
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useReadingRoomThreadRuntime,
    adapter: fixtureThreadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="rr-app">
        <div
          className={`rr-scrim${drawerOpen ? " open" : ""}`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
        <Sidebar drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />
        <div className="s-main">
          <Thread onOpenDrawer={() => setDrawerOpen(true)} />
          <Composer />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
};

export default App;
