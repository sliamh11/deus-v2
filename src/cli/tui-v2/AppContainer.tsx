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
 *
 * Build-sequence step 9 additions, all funneled through `submitTurn` before
 * a line ever reaches the chat transport:
 * 1. `executeSlashCommand` (`commands/registry.ts`) — a recognized
 *    `/command` runs locally and never reaches `bridge.submitTurn` at all
 *    (`result.handled`short-circuits).
 * 2. `resolveAtMentions`/`appendResolvedMentions`
 *    (`at-mentions/at-mention-processor.ts`) — otherwise, any `@path`
 *    mentions in the line are expanded against real Node `fs` (this file is
 *    where the real, non-injected filesystem deps live; every other module
 *    that touches `@path` resolution takes them as injectable params for
 *    testability) before the (possibly-expanded) text reaches the bridge.
 * 3. `createIdleNotifier` (`notifications/idle-notify.ts`) — `onBusyChange`
 *    fires `notifyTurnComplete` on the false (turn-finished) transition;
 *    every composer keystroke and submitted line calls `recordActivity`.
 */

import type React from 'react';
import { useRef, useState } from 'react';
import { render as inkRender } from 'ink';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

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
import { themeManager } from './themes/theme-manager.js';
import { createClipboardWriter } from './utils/clipboard.js';
import {
  ALL_COMMANDS,
  createSlashCommandRegistry,
  executeSlashCommand,
  type SlashCommandContext,
} from './commands/index.js';
import {
  appendResolvedMentions,
  resolveAtMentions,
  type AtMentionFsDeps,
} from './at-mentions/at-mention-processor.js';
import { createIdleNotifier } from './notifications/idle-notify.js';

const clipboardWriter = createClipboardWriter();
const commandRegistry = createSlashCommandRegistry(ALL_COMMANDS);
const realAtMentionFsDeps: AtMentionFsDeps = {
  readFile: (path) => readFile(path, 'utf-8'),
  stat: (path) => stat(path),
  readdir: (path) => readdir(path),
  resolvePath: (cwd, name) => resolvePath(cwd, name),
};

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
  const idleNotifierRef = useRef<ReturnType<typeof createIdleNotifier> | null>(null);
  if (idleNotifierRef.current === null) {
    idleNotifierRef.current = createIdleNotifier();
  }
  const idleNotifier = idleNotifierRef.current;

  const bridgeRef = useRef<ChatStreamBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = createChatStreamBridge({
      transport,
      cwd,
      getState,
      setState,
      onBusyChange: (next) => {
        setBusy(next);
        if (!next) idleNotifier.notifyTurnComplete('Turn complete');
      },
    });
  }
  const bridge = bridgeRef.current;

  function lastAssistantText(): string | undefined {
    const transcript = getState().transcript;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].kind === 'assistant') return transcript[i].text;
    }
    return undefined;
  }

  function buildSlashCommandContext(): SlashCommandContext {
    return {
      invocation: { raw: '', name: '', args: '' },
      services: { transport, themeManager, clipboard: clipboardWriter },
      ui: {
        info: (text) =>
          dispatchLocal({ type: 'display_event', event: { kind: 'progress', text } }),
        error: (text) =>
          dispatchLocal({
            type: 'display_event',
            event: { kind: 'chat_error', message: text },
          }),
        clear: () => setState({ ...getState(), transcript: [] }),
        lastAssistantText,
      },
      cwd,
      onExit,
    };
  }

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
   *
   * Build-sequence step 9: a non-blank trimmed line now goes through
   * `executeSlashCommand` first (see module doc); only an unhandled
   * (non-`/command`) line falls through to `@path` mention expansion and
   * the bridge, same as before this step.
   */
  function submitTurn(prompt: string): void {
    if (busy) return;
    idleNotifier.recordActivity();
    dispatchLocal({ type: 'input_change', value: prompt });
    dispatchLocal({ type: 'submit_input' });
    const trimmed = prompt.trim();
    if (trimmed === '') return;

    // Command dispatch and `@path` resolution are both async (a command may
    // call `transport.status()`; mention resolution does real file I/O), but
    // the `busy` guard above only re-checks React state, which the bridge
    // doesn't set true until `bridge.submitTurn` is actually reached below —
    // without this, a fast second Enter during that async gap would sail
    // past the guard and dispatch a second, overlapping submission. Setting
    // `busy` true here, synchronously, before any `await`, closes that gap;
    // `bridge.submitTurn` (when reached) redundantly sets it true again via
    // its own `onBusyChange`, which is harmless, and reliably flips it back
    // to false when the turn resolves. The one path that never reaches the
    // bridge (a handled slash command) is responsible for flipping it back
    // itself, in the `finally` below.
    setBusy(true);
    void (async () => {
      try {
        const commandContext = buildSlashCommandContext();
        const result = await executeSlashCommand(commandRegistry, trimmed, commandContext);
        if (result.handled) {
          setBusy(false);
          return;
        }

        const mentions = await resolveAtMentions(trimmed, cwd, realAtMentionFsDeps);
        for (const error of mentions.errors) {
          dispatchLocal({
            type: 'display_event',
            event: { kind: 'chat_error', message: error },
          });
        }
        const expanded = appendResolvedMentions(trimmed, mentions);
        await bridge.submitTurn(expanded);
      } catch {
        // bridge.submitTurn itself never rejects (see its own module doc);
        // this only guards executeSlashCommand/resolveAtMentions, neither of
        // which should throw either, but `busy` must never get stuck true.
        setBusy(false);
      }
    })();
  }

  const value: AppStateValue = {
    state,
    busy,
    setInput: (next) => {
      idleNotifier.recordActivity();
      dispatchLocal({ type: 'input_change', value: next });
    },
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
