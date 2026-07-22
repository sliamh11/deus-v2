/**
 * `ChatTransport` <-> `tuiReduce` adapter for `deus tui`'s v2 (Gemini-chrome
 * fork) UI, per the plan's resolved design decision #2
 * (`~/.claude/plans/deus-tui-gemini-fork.md`): this is the new file that
 * takes over `useGeminiStream.ts`'s *role* — bridging a streamed backend
 * into UI state — without reusing any of its internals (Gemini's hook owns
 * a client-side tool-execution tracker; Deus's tools execute and get
 * permission-gated entirely in the daemon, so the client only ever
 * consumes an already-resolved `ChatDisplayEvent` stream). `tuiReduce`
 * (`deus-tui-state.ts`) stays the single source of truth for UI state; this
 * module drives it, it never duplicates its logic.
 *
 * Deliberately UI-framework-free (no Ink/React import) so it can be built
 * and unit-tested against a fake `ChatTransport`, independent of any UI
 * component, per the plan's build-sequence step 5. A later step (App.tsx /
 * AppContainer.tsx, step 6) wires `getState`/`setState` to real component
 * state and calls `submitTurn`/`respondPermission` from event handlers —
 * the same seam `src/cli/tui/deus-tui-app.tsx`'s `App` component currently
 * implements inline (`onTurnEvent`, `handleSubmitLine`,
 * `handlePermissionKeypress`), extracted here so it's independently
 * testable and reusable by the v2 UI shell.
 *
 * Ported behavior, preserved exactly from `tui/deus-tui-app.tsx`:
 * - A `permission_request` display event pauses the turn's event stream
 *   (the same way the readline `deus chat` client's `render()` blocks on a
 *   `Promise` — `deus-native-chat-client.ts` lines 337-365) until
 *   `respondPermission` resolves a decision.
 * - `respondPermission` unblocks the paused stream SYNCHRONOUSLY, before
 *   `transport.respondPermission()`'s network round-trip settles — the
 *   turn is expected to be paused server-side regardless, so the client
 *   only needs to fire the response and keep consuming the stream, not
 *   wait on the POST. This is a deliberate, load-bearing ordering carried
 *   forward unchanged from `deus-tui-app.tsx`'s `handlePermissionKeypress`
 *   — do not "simplify" it to await the network call first.
 * - `busy` (a turn in flight) gates a second concurrent `submitTurn` call
 *   the same way `deus-tui-app.tsx`'s local `busy` state + `handleSubmitLine`'s
 *   `if (busy) return;` guard does, upholding the same
 *   never-call-transport.turn()-twice-concurrently invariant the readline
 *   client's line queue exists for (see `deus-tui-app.tsx`'s module doc).
 */

import type { ChatTransport } from '../deus-native-chat-client.js';
import type { ChatDisplayEvent } from '../deus-native-chat.js';
import { DENY_TIMEOUT_MS } from '../../agent-runtimes/permission-registry.js';
import { tuiReduce, type TuiAction, type TuiState } from './deus-tui-state.js';
import type { PermissionListKeypress } from './deus-tui-permission-decision-v2.js';

export interface ChatStreamBridgeDeps {
  transport: ChatTransport;
  cwd: string;
  /** Always read fresh — never cache a snapshot across an `await`. */
  getState: () => TuiState;
  setState: (state: TuiState) => void;
  /** Optional: notified whenever `isBusy()` changes, for UI wiring (e.g. gating input) that wants to react without polling. */
  onBusyChange?: (busy: boolean) => void;
}

export interface ChatStreamBridge {
  /**
   * Submit one user turn. Streams the resulting `ChatDisplayEvent`s into
   * `tuiReduce` via `setState`, pausing internally on a `permission_request`
   * until `respondPermission` resolves it. No-ops (does not call
   * `transport.turn` again) if a turn is already in flight. Never rejects —
   * a transport failure is surfaced as a `chat_error` display event, not a
   * thrown error, mirroring `deus-tui-app.tsx`'s `handleSubmitLine`.
   */
  submitTurn(prompt: string): Promise<void>;
  /**
   * Resolve the currently open permission modal for one keypress, per
   * `deus-tui-permission-decision-v2.ts`'s arrow-key list-select contract
   * (build-sequence step 8). No-ops if no permission modal is open, or if
   * the keypress only moves the cursor / is inert (the modal stays open,
   * the stream stays paused) rather than resolving a decision.
   */
  respondPermission(key: PermissionListKeypress): void;
  /** True while a `submitTurn` call has not yet resolved. */
  isBusy(): boolean;
}

const TURN_FAILED_MESSAGE =
  'the chat request failed. Is the Deus service still running?';

function permissionResponseFailedMessage(): string {
  return `failed to send the permission response; this request will auto-deny in ${DENY_TIMEOUT_MS / 1_000}s.`;
}

export function createChatStreamBridge(
  deps: ChatStreamBridgeDeps,
): ChatStreamBridge {
  const { transport, cwd, getState, setState, onBusyChange } = deps;

  let busy = false;
  let pendingPermissionResolve: (() => void) | undefined;

  function setBusy(next: boolean): void {
    if (busy === next) return;
    busy = next;
    onBusyChange?.(next);
  }

  function dispatch(action: TuiAction): void {
    setState(tuiReduce(getState(), action).state);
  }

  async function onTurnEvent(event: ChatDisplayEvent): Promise<void> {
    dispatch({ type: 'display_event', event });
    if (event.kind === 'permission_request') {
      await new Promise<void>((resolve) => {
        pendingPermissionResolve = resolve;
      });
    }
  }

  async function submitTurn(prompt: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await transport.turn(prompt, cwd, onTurnEvent);
    } catch {
      dispatch({
        type: 'display_event',
        event: { kind: 'chat_error', message: TURN_FAILED_MESSAGE },
      });
    } finally {
      setBusy(false);
    }
  }

  function respondPermission(key: PermissionListKeypress): void {
    const state = getState();
    if (!state.permission) return;
    const requestId = state.permission.requestId;

    const result = tuiReduce(state, {
      type: 'permission_keypress',
      key,
    });
    setState(result.state);
    if (result.permissionDecision === undefined) return;

    // Fire-and-forget: the network response is not on the critical path for
    // unblocking the paused turn (see module doc). A failure is surfaced as
    // a transcript error, not by re-opening the modal or re-blocking.
    void transport
      .respondPermission(requestId, result.permissionDecision)
      .catch(() => {
        dispatch({
          type: 'display_event',
          event: {
            kind: 'chat_error',
            message: permissionResponseFailedMessage(),
          },
        });
      });

    const resolvePending = pendingPermissionResolve;
    pendingPermissionResolve = undefined;
    resolvePending?.();
  }

  return {
    submitTurn,
    respondPermission,
    isBusy: () => busy,
  };
}
