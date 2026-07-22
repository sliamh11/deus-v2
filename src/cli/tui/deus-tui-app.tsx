/**
 * Root `<App>` component for `deus tui` (Track B steps 5-8 of
 * LIA-471's spec) and
 * `launchTuiApp`, the real `LaunchTuiApp` `deus-tui-entry.ts` wires in.
 *
 * Owns the transport (`ChatTransport` from `deus-native-chat-client.ts`,
 * reused UNCHANGED — no protocol changes here), drives
 * `deus-tui-state.ts`'s pure reducer off `transport.turn()`'s streamed
 * `ChatDisplayEvent`s, and composes `StatusHeader` / `TranscriptPane` /
 * `InputLine` / `PermissionModal` / `CommandPalette`. This file is the only
 * place local commands (`/plan on|off`, `/status`, `/exit`, `/quit`) are
 * interpreted — mirroring `deus-native-chat-client.ts`'s single
 * `handleLine` switch (lines 408-447) — so `InputLine` and `CommandPalette`
 * both funnel through `handleSubmitLine`/`runLocalCommand` instead of each
 * re-implementing the command list.
 *
 * Permission events: exactly like the readline client's `render()` (which
 * `await`s a `Promise` that only resolves once the terminal user answers,
 * lines 337-365), `onTurnEvent` here awaits a matching `Promise` for
 * `kind: 'permission_request'` before returning — the streamed turn is
 * expected to be paused server-side until the response is sent, so the
 * client-side event consumer must block the same way, or a later event in
 * the same turn could be misattributed to before the permission was
 * answered.
 *
 * Deviation from the readline client's queuing model (logged per this
 * repo's `Deviation:` convention): the readline client queues lines typed
 * while a turn is in flight and drains them sequentially
 * (`deus-native-chat-client.ts`'s `pump`/`queue`, asserted via its test's
 * `sawOverlap` check). Ink's synchronous raw-mode input model makes a
 * matching queue meaningfully more code for a single-user interactive TUI;
 * this component instead disables `InputLine` (`isActive={false}`) while a
 * turn is in flight (`busy`), which upholds the SAME invariant the original
 * queue exists for — `transport.turn()` is never called a second time
 * before the first resolves — via visible-to-the-user blocking instead of
 * silent queuing.
 */

import { useRef, useState } from 'react';
import { Box, render as inkRender } from 'ink';

import {
  CHAT_UNAVAILABLE_MESSAGE,
  type ChatTransport,
} from '../deus-native-chat-client.js';
import type {
  ChatDisplayEvent,
  NativeChatStatus,
} from '../deus-native-chat.js';
import { DENY_TIMEOUT_MS } from '../../agent-runtimes/permission-registry.js';
import {
  createInitialTuiState,
  tuiReduce,
  type TuiAction,
  type TuiState,
} from './deus-tui-state.js';
import type { PermissionKeypress } from './deus-tui-permission-decision.js';
import { StatusHeader } from './components/StatusHeader.js';
import { TranscriptPane } from './components/TranscriptPane.js';
import { InputLine } from './components/InputLine.js';
import { PermissionModal } from './components/PermissionModal.js';
import { CommandPalette } from './components/CommandPalette.js';

/** Mirrors `deus-native-chat-client.ts`'s `renderStatus` field set exactly (5 lines, incl. `output`). */
function formatStatus(status: NativeChatStatus): string {
  return [
    `Backend: ${status.backend}`,
    `Mode:    ${status.mode} (${status.permissionProfile})`,
    `Session: ${status.sessionId ?? 'not started'}`,
    `State:   ${status.state}`,
    `Output:  ${status.output}`,
  ].join('\n');
}

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

export interface AppProps {
  transport: ChatTransport;
  cwd: string;
  initialStatus: NativeChatStatus;
  onExit: () => void;
}

export function App({
  transport,
  cwd,
  initialStatus,
  onExit,
}: AppProps): JSX.Element {
  const [state, setState] = useState<TuiState>(() =>
    buildInitialState(initialStatus),
  );
  const [busy, setBusy] = useState(false);
  const pendingPermissionResolveRef = useRef<(() => void) | undefined>(
    undefined,
  );

  const dispatch = (action: TuiAction): void => {
    setState((prev) => tuiReduce(prev, action).state);
  };

  const onTurnEvent = async (event: ChatDisplayEvent): Promise<void> => {
    dispatch({ type: 'display_event', event });
    if (event.kind === 'permission_request') {
      await new Promise<void>((resolve) => {
        pendingPermissionResolveRef.current = resolve;
      });
    }
  };

  async function runLocalCommand(line: string): Promise<boolean> {
    if (line === '/exit' || line === '/quit') {
      onExit();
      return true;
    }
    if (line === '/status') {
      try {
        const status = await transport.status();
        dispatch({ type: 'status_updated', status });
        dispatch({
          type: 'display_event',
          event: { kind: 'progress', text: formatStatus(status) },
        });
      } catch {
        dispatch({
          type: 'display_event',
          event: { kind: 'chat_error', message: CHAT_UNAVAILABLE_MESSAGE },
        });
      }
      return true;
    }
    if (line === '/plan on' || line === '/plan off') {
      try {
        const status = await transport.setPlanMode(line === '/plan on');
        dispatch({ type: 'status_updated', status });
      } catch {
        dispatch({
          type: 'display_event',
          event: { kind: 'chat_error', message: CHAT_UNAVAILABLE_MESSAGE },
        });
      }
      return true;
    }
    if (/^\/plan(?:\s|$)/.test(line)) {
      dispatch({
        type: 'display_event',
        event: { kind: 'progress', text: 'Usage: /plan on|off' },
      });
      return true;
    }
    return false;
  }

  const handleSubmitLine = (raw: string): void => {
    if (busy) return;
    const line = raw.trim();
    // Route the submitted text (which may come from InputLine's own
    // `state.input` or, via CommandPalette, an arbitrary selected command
    // string) through the same input_change+submit_input pair the reducer
    // already exposes, rather than adding a second "append arbitrary text"
    // action — keeps deus-tui-state.ts's action surface exactly as built.
    dispatch({ type: 'input_change', value: raw });
    dispatch({ type: 'submit_input' });
    if (line === '') return;
    void (async () => {
      const handled = await runLocalCommand(line);
      if (handled) return;
      setBusy(true);
      try {
        await transport.turn(line, cwd, onTurnEvent);
      } catch {
        dispatch({
          type: 'display_event',
          event: {
            kind: 'chat_error',
            message:
              'the chat request failed. Is the Deus service still running?',
          },
        });
      } finally {
        setBusy(false);
      }
    })();
  };

  const handlePermissionKeypress = (
    input: string,
    key: PermissionKeypress,
  ): void => {
    const result = tuiReduce(state, {
      type: 'permission_keypress',
      input,
      key,
    });
    const requestId = state.permission?.requestId;
    setState(result.state);
    if (result.permissionDecision === undefined) return;

    if (requestId) {
      void transport
        .respondPermission(requestId, result.permissionDecision)
        .catch(() => {
          setState((current) => ({
            ...current,
            transcript: [
              ...current.transcript,
              {
                id: current.transcript.length,
                kind: 'error',
                text: `failed to send the permission response; this request will auto-deny in ${DENY_TIMEOUT_MS / 1_000}s.`,
              },
            ],
          }));
        });
    }
    const resolvePending = pendingPermissionResolveRef.current;
    pendingPermissionResolveRef.current = undefined;
    resolvePending?.();
  };

  const inputActive = !state.permission && !state.palette.open && !busy;

  return (
    <Box flexDirection="column">
      <StatusHeader status={state.status} />
      <TranscriptPane entries={state.transcript} />
      {state.permission ? (
        <PermissionModal
          key={state.permission.requestId}
          toolName={state.permission.toolName}
          toolInputPreview={state.permission.toolInputPreview}
          onKeypress={handlePermissionKeypress}
        />
      ) : state.palette.open ? (
        <CommandPalette
          onSelect={(command) => {
            dispatch({ type: 'close_palette' });
            handleSubmitLine(command);
          }}
          onClose={() => dispatch({ type: 'close_palette' })}
        />
      ) : (
        <InputLine
          value={state.input}
          isActive={inputActive}
          onChange={(value) => dispatch({ type: 'input_change', value })}
          onSubmit={handleSubmitLine}
          onOpenPalette={() => dispatch({ type: 'open_palette' })}
        />
      )}
    </Box>
  );
}

export interface LaunchTuiAppOptions {
  errorOutput?: NodeJS.WritableStream;
}

/**
 * Real `LaunchTuiApp` implementation `deus-tui-entry.ts` wires in. Mirrors
 * `runChatCli`'s own startup liveness check (`deus-native-chat-client.ts:
 * 284-290`): a valid-shaped discovery record only proves a file exists, not
 * that the daemon is actually reachable, so this fetches `transport.status()`
 * once BEFORE ever rendering, and fails closed with `CHAT_UNAVAILABLE_MESSAGE`
 * + exit code 1 exactly like the readline client does, instead of rendering a
 * TUI shell against a dead daemon.
 *
 * Completion is driven by Ink's own `instance.waitUntilExit()` rather than a
 * bespoke exit-code channel: raw mode disables the terminal's SIGINT
 * generation (that's why Ink implements `exitOnCtrlC` itself, rather than
 * relying on a process `SIGINT` handler), so Ctrl+C unmounts via Ink's own
 * internal path, not `<App>`'s `onExit` prop — `waitUntilExit()` resolves
 * either way. The readline client's interactive loop never returns a nonzero
 * exit code from any of its own completion paths (/exit, /quit, EOF, SIGINT
 * all resolve `finish(0)`), so this mirrors that: 0 once the app exits.
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
    <App
      transport={transport}
      cwd={cwd}
      initialStatus={initialStatus}
      onExit={() => instance?.unmount()}
    />,
  );
  await instance.waitUntilExit();
  return 0;
}
