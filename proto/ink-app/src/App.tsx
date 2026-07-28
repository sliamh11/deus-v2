// LIA-496 — root component. Same `AssistantRuntimeProvider(
// useRemoteThreadListRuntime(...))` pattern as the web target
// ("Reading Room"), Ink-side — the runtime layer proven target-blind by
// LIA-495 stays that way here too; only this file's JSX (Ink primitives
// instead of DOM) is target-specific.
//
// `useThreadRuntime` (this file's `runtimeHook`) is mounted BY
// `useRemoteThreadListRuntime` once per active thread, inside
// `ThreadListItemRuntimeProvider` — confirmed by reading
// node_modules/@assistant-ui/core/src/react/runtimes/
// RemoteThreadListHookInstanceManager.tsx directly (`_OuterActiveThreadProvider`
// wraps `Provider` + `_RuntimeBinder` in `ThreadListItemRuntimeProvider`),
// so `useAui()` inside it is genuinely scoped to that thread's
// `remoteId` — the exact mechanism shared/src/threadList.tsx's own
// `unstable_Provider` already depends on (see that file's header comment).
//
// Consuming call sites mounted directly below (verify against this JSX,
// not the individual files' own comments):
//   - `Sidebar` ← here, sibling to the thread column.
//   - `UserMessage`/`AssistantMessage` (from `Messages.tsx`) ← here, via
//     `ThreadPrimitive.Messages`'s `components` prop.
//   - `EmptyState` ← here, via `ThreadPrimitive.Empty`.
//   - `Composer` ← here, sibling to `ThreadPrimitive.Messages`, inside the
//     same `ThreadPrimitive.Root` (the exact position LIA-495's composer
//     regression lived in — see Composer.tsx's own header comment).
//
// Tab-driven pane switching is Ink's OWN native `useFocus` mechanism —
// deliberately NOT a hand-rolled App-level Tab handler. **BUILD-stage
// finding, corrected after a real misdiagnosis**: an EARLIER version of
// this file added its own `useInput`-based `key.tab` toggle because a
// first read of `node_modules/ink/build/components/App.js`'s
// `handleTabNavigation` (which checks raw `input === '\t'`) against this
// file's OWN `useInput` callback (which reports `input === ""` for Tab,
// `key.tab: true`) looked like a mismatch/bug. Tracing `App.js`'s actual
// event pipeline further showed the two are DIFFERENT layers reading the
// SAME keypress correctly: `emitInput` forwards the RAW un-parsed string
// (which genuinely is `'\t'` for a Tab byte) straight to
// `handleTabNavigation`, while `useInput`'s hook applies its OWN
// `parseKeypress` normalization (Tab → `input:""` + `key.tab:true`,
// consistent with how it also normalizes arrow keys) before calling a
// consumer's callback — so Ink's native Tab-cycling was NEVER broken.
// Confirmed directly by temporarily instrumenting `addFocusable`/
// `removeFocusable`/the `autoFocus` claim check in a local copy of
// `App.js` (not committed) and observing `activeFocusId` genuinely
// advancing between registered `useFocus` ids on a real Tab keypress.
// The App-level `useInput`+`focusedPane` state this file used to carry
// was a SECOND, REDUNDANT focus mechanism running in parallel with Ink's
// own — and the two fighting over the SAME Tab keypress (Ink's native
// `focusNext()` reassigning `activeFocusId` out from under a
// `ComposerPrimitive.Input` this file was ALSO unmounting/remounting on
// the identical keystroke) is what produced the actually-broken symptom
// (composer silently stopped accepting typed input after a
// sidebar-then-back cycle). Removed entirely — `Sidebar.tsx` now owns its
// own `useFocus({id:"sidebar"})` again, and `Composer.tsx` no longer
// unmounts for pane-switching purposes (see both files' own header
// comments for the corrected design and how each verified it against a
// real run, not just this trace).
import { useMemo, type FC } from "react";
import { Box, Text } from "ink";
import { AssistantRuntimeProvider, useRemoteThreadListRuntime, useLocalRuntime, useAui, useAuiState, ThreadPrimitive } from "@assistant-ui/react-ink";
import { getFixtureAdapter, fixtureThreadListAdapter } from "@lia496/shared";
import { theme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { UserMessage, AssistantMessage } from "./components/Messages";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { CodeCopyHotkey } from "./components/CodeCopyHotkey";
import { clearFreshDraft, useIsFreshDraft } from "./freshDraftTracker";

function useThreadRuntime() {
  const aui = useAui();
  const state = aui.threadListItem.getState();
  // `.remoteId` is undefined until a brand-new thread's `initialize()`
  // resolves; `.id` is always defined and — per
  // shared/src/threadList.tsx's `initialize`, which reuses the local id as
  // the remoteId 1:1 for this fixture — resolves to the exact same string
  // either way, so this never mismatches the adapter this thread ends up
  // registered under.
  const id = state.remoteId ?? state.id;
  const baseAdapter = getFixtureAdapter(id);
  // Code-review fix (LIA-496 REVISE round) — see `freshDraftTracker.ts`'s
  // header comment for the full root-cause trace. This thread's own
  // `_OuterActiveThreadProvider` subtree is keyed by `id` (confirmed by
  // reading `RemoteThreadListHookInstanceManager.tsx`'s
  // `__internal_RenderThreadRuntimes`), so `useThreadRuntime` runs exactly
  // once per thread id — `useMemo([baseAdapter, id])` below wraps the
  // fixture adapter ONCE per thread, not per render, and calling
  // `clearFreshDraft(id)` on every `run()` (not just the first) is a cheap
  // no-op once the id is no longer tracked.
  const adapter = useMemo(
    () => ({
      run: (options: Parameters<typeof baseAdapter.run>[0]) => {
        clearFreshDraft(id);
        return baseAdapter.run(options);
      },
    }),
    [baseAdapter, id],
  );
  return useLocalRuntime(adapter);
}

// `useAuiState` must be called from a component that is a DESCENDANT of
// `AssistantRuntimeProvider` — calling it directly in `App`'s own body
// (above/outside the `<AssistantRuntimeProvider>` it returns) throws
// "You are using a component or hook that requires an AuiProvider"
// (confirmed by actually running the app: real crash on first launch, not
// a hypothetical). `MainPane` exists specifically to be mounted AS a
// child of the provider so the hook resolves inside its context.
const MainPane: FC = () => {
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  // Code-review fix (LIA-496 REVISE round): `ctrl+n`'s message pane not
  // rebinding — see `freshDraftTracker.ts`'s header comment for the full
  // root-cause trace (a confirmed `@assistant-ui/store` staleness in the
  // `s.thread`/`ThreadPrimitive.*` reactive chain, live-reproduced, not
  // fixable by remounting/keying/delaying this component — all three were
  // tried and disproven live before landing here). `isFreshDraft` is
  // derived from OUR OWN bookkeeping (`Sidebar.tsx` marks a thread fresh
  // the moment `switchToNewThread()` resolves; `useThreadRuntime` above
  // clears it the moment that thread's adapter actually runs a turn) —
  // never from the unreliable `s.thread` scope — so it stays correct
  // regardless of the upstream bug.
  //
  // KNOWN REMAINING RISK (found during THIS fix's own re-verification,
  // logged honestly rather than hidden): two `switchToNewThread()` calls
  // in rapid succession within the SAME session — e.g. `ctrl+n` → send →
  // switch to a seeded thread → `ctrl+n` again — can still surface
  // content from the FIRST draft bleeding into the SECOND one once a
  // message is actually submitted there (this workaround only forces
  // `EmptyState` up to that point; the hand-off back to
  // `ThreadPrimitive.Messages` on submit still goes through the same
  // unreliable `s.thread` chain). Reproduced 3+ times live; not resolved
  // by this fix. The single-`ctrl+n` case this file's/Sidebar's own
  // review finding named — pane not clearing, then a submitted message
  // not landing isolated — IS fixed and re-verified (see VERIFICATION.md).
  // The compounding two-draft case needs either a real upstream fix or a
  // full from-scratch message-list render bypassing `ThreadPrimitive.*`
  // for local threads; out of scope for this pass.
  const isFreshDraft = useIsFreshDraft(mainThreadId);
  return (
    <ThreadPrimitive.Root>
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {isFreshDraft ? (
          <EmptyState />
        ) : (
          <>
            <ThreadPrimitive.Empty>
              <EmptyState />
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </>
        )}
      </Box>
      <Composer />
    </ThreadPrimitive.Root>
  );
};

const App: FC = () => {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useThreadRuntime,
    adapter: fixtureThreadListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" width={104} borderStyle="round" borderColor={theme.line} backgroundColor={theme.bg}>
        <Box
          borderStyle="single"
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.line}
          paddingX={1}
          justifyContent="space-between"
        >
          <Text color={theme.ink}>
            deus <Text color={theme.amber}>{"//"}</Text> transcript
          </Text>
          <Text color={theme.dim}>
            model: <Text color={theme.ok}>sonnet-5</Text>
          </Text>
        </Box>
        <Box flexDirection="row" flexGrow={1}>
          <Sidebar />
          <Box flexDirection="column" flexGrow={1}>
            <MainPane />
          </Box>
        </Box>
      </Box>
      <CodeCopyHotkey />
    </AssistantRuntimeProvider>
  );
};

export default App;
