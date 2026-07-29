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
// LIA-496 IB1 (I1/I2/I3/I4/I5) — terminal-native canvas rewrite. Consuming
// call sites mounted directly below (verify against this JSX, not the
// individual files' own comments):
//   - `CommittedTranscript` (`committedBlocks.tsx`) ← here, the `<Static>`-
//     backed, ever-growing, append-only scrollback. Owns the once-printed
//     identity banner and every "── thread: <title> ──" switch banner.
//   - `LiveMessageTail` (`committedBlocks.tsx`) ← here, the NOT-yet-
//     committed remainder of the ONE still-live message (if any) — commits
//     at PART granularity (REVISE round fix), so most of a long streaming
//     message already lives in `CommittedTranscript` by the time it
//     finishes; only the part(s) still actively streaming stay here.
//   - `ThreadPicker` (`components/ThreadPicker.tsx`) ← here, a transient
//     overlay (replaces the old persistent `Sidebar.tsx`, deleted by this
//     batch — a persistent 34-column rail is geometrically impossible once
//     transcript lines are printed into real scrollback), toggled by
//     `ctrl+t` or the composer's `/threads` command.
//   - `StatusLine`/`Composer` ← here, sibling to the dynamic content,
//     inside the same `ThreadPrimitive.Root` (the exact position LIA-495's
//     composer regression lived in — see Composer.tsx's own header
//     comment).
//
// I1 — the painted truecolor background (`backgroundColor={theme.bg}` on
// this file's own outer frame, `backgroundColor={theme.side}` on the old
// `Sidebar.tsx`) is gone. I5 — so is the outer rounded border and the
// boxed header row; `CommittedTranscript`'s identity banner and
// `StatusLine` below replace both. I4 — the old hardcoded `width={104}`
// is gone too; `useResponsiveWidth` (own file, read its header comment)
// supplies a real, resize-subscribed value instead.
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
// IB1 note: with `Sidebar.tsx` gone, `ThreadPicker` is transient (not
// Tab-focusable while closed) and `Composer`'s `TextInput` is now the only
// standing focus stop — Tab-cycling has nothing left to cycle BETWEEN
// during normal use, which is expected, not a regression of the fix above.
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { Box, useApp, useInput } from "ink";
import { AssistantRuntimeProvider, useRemoteThreadListRuntime, useLocalRuntime, useAui, useAuiState, ThreadPrimitive } from "@assistant-ui/react-ink";
import { getFixtureAdapter, fixtureThreadListAdapter } from "@lia496/shared";
import { Composer, useIsAwaitingApproval } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { CodeCopyHotkey } from "./components/CodeCopyHotkey";
import { ThreadPicker } from "./components/ThreadPicker";
import { StatusLine } from "./components/StatusLine";
import { CommittedTranscript, LiveMessageTail, useCommittedBlocks } from "./committedBlocks";
import { clearFreshDraft, markFreshDraft, useIsFreshDraft } from "./freshDraftTracker";
import { useResponsiveWidth } from "./useResponsiveWidth";

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

// Global thread-navigation: `ctrl+n` (new thread) and `ctrl+t` (toggle the
// `ThreadPicker` overlay) both need to be ALWAYS active regardless of
// whatever else has focus/is mounted — same as old `Sidebar.tsx`'s own
// unconditional `ctrl+n` handler (its header comment: "always active
// regardless of focus"). Deliberately owned here, in `MainPane` (ALWAYS
// mounted for the lifetime of the app), rather than inside
// `ThreadPicker.tsx` itself: `ThreadPicker` unmounts on close, and the
// fresh-draft bookkeeping below (`awaitingFreshDraftRef` + the `useEffect`
// watching `mainThreadId`) needs to survive past the exact keystroke that
// triggers it — see `freshDraftTracker.ts`'s header comment for the full
// known-upstream-bug trace this bookkeeping works around (the
// `MainPane`-level comment further down documents the one compounding
// case it does NOT fix). `ThreadPicker`'s own "n: new session" binding
// calls the SAME `triggerNewThread` returned here, so there is exactly one
// place this reactive path is implemented, not two that could drift
// apart.
//
// Code-review fix (LIA-496 REVISE round — untested-interaction finding):
// the picker must never be OPEN while a permission decision is pending.
// `MainPane`'s JSX (below) swaps its ENTIRE dynamic-tail block — including
// `LiveMessageTail` (which is what actually renders the live
// `PermissionPrompt`) — for `ThreadPicker` whenever `pickerOpen` is true;
// opening the picker mid-decision would unmount the interactive
// `useInput`-driven prompt out from under the user, and the picker's own
// `Enter` could then switch threads with that approval left permanently
// unresolved (neither committed nor rendered — a real dead end, not just a
// cosmetic gap). `useIsAwaitingApproval` (`Composer.tsx`, exported for
// exactly this reuse rather than re-implementing the same predicate here —
// this repo's own "never duplicate content across files" rule) is the
// SAME check `Composer.tsx` already uses to decide whether its own
// interactive input is safe to keep mounted; reusing it here means the two
// "is it safe to keep this pane's interactive surface mounted" decisions
// can never drift apart. Two guards, not one, since a decision can become
// pending at any time relative to when the picker was opened: `openPicker`
// refuses to open while pending (covers `ctrl+t` and the composer's
// `/threads` path, both of which route through it), and the `useEffect`
// below force-closes an ALREADY-open picker the instant a decision
// arrives mid-open (a running turn's tool call can flip to
// `requires-action` at any moment, independent of what overlay happens to
// be open).
//
// LIA-496 IB4 (I16 verification finding) — `ctrl+n` had the exact same
// unmount hazard the `ctrl+t` guard above already documents, but no guard
// of its own: `triggerNewThread()` calls `aui.threads.switchToNewThread()`,
// which flips `mainThreadId`, which flips `isFreshDraft` true, which swaps
// `MainPane`'s JSX from `LiveMessageTail` (the ONLY thing that mounts the
// live `PermissionPrompt`) to a plain `<EmptyState />` — unmounting a
// pending approval's `useInput` out from under the user, leaving it
// neither committed nor rendered, exactly the dead end the `ctrl+t` fix
// above was written to prevent. Found by tracing this mechanism directly
// while verifying I16 (not assumed fixed by I3/I14's structural changes —
// it wasn't, for this specific keybinding), confirmed as a real gap, and
// fixed below with the identical guard shape `ctrl+t` already uses.
//
// I14 (D1) also adds a genuinely new always-active binding here: ctrl+c.
// `main.tsx` sets `exitOnCtrlC: false` (see that file's header comment for
// the mechanism this rests on), so Ink no longer exits the process on
// ctrl+c by itself — this hook now owns that behavior manually via
// `useApp().exit()`, but ONLY when no approval is pending. When one IS
// pending, this handler's own `hasPendingApproval` guard makes ctrl+c here
// a no-op, and `PermissionPrompt.tsx`'s own `useInput` (isActive'd on the
// pending approval) is the one that consumes the keystroke instead,
// resolving it as a deny — the two can never both fire for the same
// keypress.
function useThreadNavigation() {
  const aui = useAui();
  const { exit } = useApp();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const awaitingFreshDraftRef = useRef(false);
  const hasPendingApproval = useIsAwaitingApproval();

  useEffect(() => {
    if (awaitingFreshDraftRef.current && mainThreadId) {
      markFreshDraft(mainThreadId);
      awaitingFreshDraftRef.current = false;
    }
  }, [mainThreadId]);

  useEffect(() => {
    if (hasPendingApproval) setPickerOpen(false);
  }, [hasPendingApproval]);

  const triggerNewThread = () => {
    awaitingFreshDraftRef.current = true;
    aui.threads.switchToNewThread();
    setPickerOpen(false);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "n") {
        if (hasPendingApproval) return; // see this hook's header comment (I16)
        triggerNewThread();
        return;
      }
      if (key.ctrl && input === "t") {
        setPickerOpen((open) => {
          if (open) return false; // closing always allowed
          return hasPendingApproval ? open : true;
        });
        return;
      }
      if (key.ctrl && input === "c") {
        if (hasPendingApproval) return; // PermissionPrompt.tsx consumes it instead
        exit();
        return;
      }
    },
    { isActive: true },
  );

  return {
    pickerOpen,
    openPicker: () => {
      if (hasPendingApproval) return;
      setPickerOpen(true);
    },
    closePicker: () => setPickerOpen(false),
    triggerNewThread,
  };
}

// `useAuiState` must be called from a component that is a DESCENDANT of
// `AssistantRuntimeProvider` — calling it directly in `App`'s own body
// (above/outside the `<AssistantRuntimeProvider>` it returns) throws
// "You are using a component or hook that requires an AuiProvider"
// (confirmed by actually running the app: real crash on first launch, not
// a hypothetical). `MainPane` exists specifically to be mounted AS a
// child of the provider so the hook resolves inside its context.
const MainPane: FC<{ width: number }> = ({ width }) => {
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  // Code-review fix (LIA-496 REVISE round): `ctrl+n`'s message pane not
  // rebinding — see `freshDraftTracker.ts`'s header comment for the full
  // root-cause trace (a confirmed `@assistant-ui/store` staleness in the
  // `s.thread`/`ThreadPrimitive.*` reactive chain, live-reproduced, not
  // fixable by remounting/keying/delaying this component — all three were
  // tried and disproven live before landing here). `isFreshDraft` is
  // derived from OUR OWN bookkeeping (`useThreadNavigation` above marks a
  // thread fresh the moment `switchToNewThread()` resolves; `useThreadRuntime`
  // above clears it the moment that thread's adapter actually runs a
  // turn) — never from the unreliable `s.thread` scope — so it stays
  // correct regardless of the upstream bug.
  //
  // KNOWN REMAINING RISK (found during the original build's own
  // re-verification, logged honestly rather than hidden): two
  // `switchToNewThread()` calls in rapid succession within the SAME
  // session — e.g. `ctrl+n` → send → switch to a seeded thread → `ctrl+n`
  // again — can still surface content from the FIRST draft bleeding into
  // the SECOND one once a message is actually submitted there (this
  // workaround only forces `EmptyState` up to that point; the hand-off
  // back to live rendering on submit still goes through the same
  // unreliable `s.thread` chain). Reproduced 3+ times live; not resolved
  // by this fix. IB1 preserves this exact boundary unchanged:
  // `ThreadPicker`'s thread switching (`switchToThread`) and its own
  // "n: new session" binding both route through `useThreadNavigation`'s
  // `triggerNewThread`/the same `mainThreadId`-driven `useEffect` above —
  // the identical reactive path the single-`ctrl+n` case already uses, not
  // a parallel one that could reintroduce the double-switch bug from a new
  // angle. The single-`ctrl+n` case this fix targets IS fixed and
  // re-verified; the compounding two-draft case needs either a real
  // upstream fix or a full from-scratch message-list render bypassing the
  // unreliable `s.thread` chain for local threads — out of scope for this
  // batch, same as it was for the original build.
  const isFreshDraft = useIsFreshDraft(mainThreadId);
  const nav = useThreadNavigation();
  // Called exactly ONCE here — `blocks` feeds `CommittedTranscript`, `tail`
  // feeds `LiveMessageTail`; see `committedBlocks.tsx`'s header comment for
  // why splitting this into two independent hook calls (one per component)
  // would risk the two halves of the transcript drifting out of sync.
  const { blocks, tail } = useCommittedBlocks();

  return (
    <>
      <CommittedTranscript width={width} blocks={blocks} />
      <ThreadPrimitive.Root>
        <Box flexDirection="column" width={width} paddingX={2} paddingY={1}>
          {nav.pickerOpen ? (
            <ThreadPicker onClose={nav.closePicker} onNewSession={nav.triggerNewThread} />
          ) : (
            <>
              {isFreshDraft ? (
                <EmptyState />
              ) : (
                <>
                  <ThreadPrimitive.Empty>
                    <EmptyState />
                  </ThreadPrimitive.Empty>
                  <LiveMessageTail tail={tail} />
                </>
              )}
              <StatusLine />
              <Composer onOpenThreadPicker={nav.openPicker} />
            </>
          )}
        </Box>
      </ThreadPrimitive.Root>
    </>
  );
};

const App: FC = () => {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useThreadRuntime,
    adapter: fixtureThreadListAdapter,
  });
  const width = useResponsiveWidth();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column">
        <MainPane width={width} />
      </Box>
      <CodeCopyHotkey />
    </AssistantRuntimeProvider>
  );
};

export default App;
