/**
 * Container/wiring root for `tui-v2` and `launchTuiApp`, the function a
 * later build-sequence step (10) points `deus-tui-entry.ts`'s `launchApp`
 * at. Named and split to mirror Gemini's real `App.tsx`/`AppContainer.tsx`
 * division (`App.tsx` presentational-only, `AppContainer.tsx` owns state and
 * every side effect) — confirmed by fetching and reading both real files
 * directly rather than assuming the split from the plan text alone. Gemini's
 * real `AppContainer.tsx` is ~2900 lines wiring auth, IDE companion, quota,
 * vim mode, mouse/scroll, extensions, and a client-side tool-execution
 * tracker through nine Context providers (see `contexts/AppStateContext.ts`'s
 * header for the exact list, read off the real file's provider tree at
 * lines 2833-2865). None of that applies to Deus's architecture (see the
 * plan's "Critical reconciled finding" — tool execution and permission
 * gating happen in the daemon, not the client) — this file's actual job is
 * narrow: own `TuiState`, wire it to `deus-chat-stream-bridge.ts`, and
 * expose the result through the ONE thin `AppStateContext`.
 *
 * State-sync detail worth flagging: `deus-chat-stream-bridge.ts`'s
 * `getState`/`setState` deps MUST always read/write the truly-current state,
 * not a stale render closure — its own module doc calls this out
 * ("Always read fresh — never cache a snapshot across an `await`"). A plain
 * `useState` value captured in a closure is only current for the render it
 * was read in; two bridge-driven `setState` calls can happen synchronously
 * back-to-back (e.g. two `display_event`s in the same microtask) with no
 * React re-render between them. `stateRef` is updated synchronously INSIDE
 * `setState` below (not just read after each render) specifically to close
 * that gap.
 */

import type React from 'react';
import { useRef, useState } from 'react';
import { render as inkRender } from 'ink';

import {
  CHAT_UNAVAILABLE_MESSAGE,
  type ChatTransport,
} from '../deus-native-chat-client.js';
import type { NativeChatStatus } from '../deus-native-chat.js';
import {
  createInitialTuiState,
  tuiReduce,
  type TuiAction,
  type TuiState,
} from './deus-tui-state.js';
import {
  createChatStreamBridge,
  type ChatStreamBridge,
} from './deus-chat-stream-bridge.js';
import { AppStateContext, type AppStateValue } from './contexts/AppStateContext.js';
import { App } from './App.js';

/** Mirrors `tui/deus-tui-app.tsx`'s `buildInitialState` exactly. */
function buildInitialState(initialStatus: NativeChatStatus): TuiState {
  const base: TuiState = { ...createInitialTuiState(), status: initialStatus };
  if (initialStatus.state !== 'resumed') return base;
  return {
    ...base,
    transcript: [
      {
        id: 0,
        kind: 'progress',
        text: 'Resumed your previous conversation (run /status for details).',
      },
    ],
  };
}

export interface AppContainerProps {
  transport: ChatTransport;
  cwd: string;
  initialStatus: NativeChatStatus;
  onExit: () => void;
}

export function AppContainer({
  transport,
  cwd,
  initialStatus,
  onExit,
}: AppContainerProps): React.ReactNode {
  const [state, setReactState] = useState<TuiState>(() =>
    buildInitialState(initialStatus),
  );
  const [busy, setBusy] = useState(false);
  const stateRef = useRef<TuiState>(state);

  // See module doc: kept in sync synchronously, not just per-render, so the
  // bridge's `getState` never returns a stale snapshot across two
  // back-to-back calls in the same tick.
  const setState = (next: TuiState): void => {
    stateRef.current = next;
    setReactState(next);
  };
  const getState = (): TuiState => stateRef.current;

  function dispatchLocal(action: TuiAction): void {
    setState(tuiReduce(getState(), action).state);
  }

  // Lazy one-time init via a ref guard (not useMemo, which React does not
  // guarantee to run exactly once) — the bridge owns internal mutable state
  // (busy flag, the pending-permission resolver) that must survive re-renders
  // as a single instance for this component's lifetime.
  const bridgeRef = useRef<ChatStreamBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = createChatStreamBridge({
      transport,
      cwd,
      getState,
      setState,
      onBusyChange: setBusy,
    });
  }
  const bridge = bridgeRef.current;

  /**
   * Mirrors `tui/deus-tui-app.tsx`'s `handleSubmitLine` exactly: the busy
   * guard runs BEFORE anything is dispatched (so nothing is appended to the
   * transcript for a submit attempt made while a turn is already in
   * flight — the composer is also disabled via `isActive={!busy}`, this is
   * belt-and-suspenders for a stray Enter during the transition), then the
   * input_change+submit_input pair `deus-tui-state.ts`'s reducer already
   * exposes appends the line to the transcript and clears `state.input`
   * regardless of whether it's blank, and only a non-blank trimmed line
   * actually reaches the bridge/transport.
   */
  function submitTurn(prompt: string): void {
    if (busy) return;
    dispatchLocal({ type: 'input_change', value: prompt });
    dispatchLocal({ type: 'submit_input' });
    const trimmed = prompt.trim();
    if (trimmed === '') return;
    void bridge.submitTurn(trimmed);
  }

  const value: AppStateValue = {
    state,
    busy,
    setInput: (next) => dispatchLocal({ type: 'input_change', value: next }),
    submitTurn,
    respondPermission: (key) => bridge.respondPermission(key),
    onExit,
  };

  return (
    <AppStateContext.Provider value={value}>
      <App />
    </AppStateContext.Provider>
  );
}

export interface LaunchTuiAppOptions {
  errorOutput?: NodeJS.WritableStream;
}

/**
 * Real `LaunchTuiApp` implementation, ported unchanged in logic from
 * `tui/deus-tui-app.tsx`'s `launchTuiApp` (only the rendered root changes,
 * `<AppContainer>` instead of `<App>`) — see that file's own doc comment for
 * the full rationale (startup liveness check via `transport.status()`
 * before ever rendering, completion driven by Ink's own
 * `waitUntilExit()`/`exitOnCtrlC` rather than a bespoke exit-code channel).
 * Not yet wired into `deus-tui-entry.ts` — that's build-sequence step 10;
 * this export is what step 10 points `launchApp` at.
 */
export async function launchTuiApp(
  transport: ChatTransport,
  cwd: string,
  options: LaunchTuiAppOptions = {},
): Promise<number> {
  const errorOutput = options.errorOutput ?? process.stderr;

  let initialStatus: NativeChatStatus;
  try {
    initialStatus = await transport.status();
  } catch {
    errorOutput.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
    return 1;
  }

  let instance: ReturnType<typeof inkRender> | undefined;
  instance = inkRender(
    <AppContainer
      transport={transport}
      cwd={cwd}
      initialStatus={initialStatus}
      onExit={() => instance?.unmount()}
    />,
  );
  await instance.waitUntilExit();
  return 0;
}
