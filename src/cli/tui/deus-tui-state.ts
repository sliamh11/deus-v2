/**
 * Pure UI-state reducer for `deus tui` (Track B of
 * /Users/liam10play/.claude/plans/expressive-foraging-reef.md). Deliberately has
 * NO Ink/React import — it consumes `ChatDisplayEvent`s (the same
 * normalized event union `deus chat` already renders, reused unchanged) and
 * local UI actions (submit input, open/close command palette, permission
 * keypress) and produces plain render state: a transcript log array,
 * permission-modal state, command-palette state, and the latest status.
 * This keeps it independently unit-testable without any terminal-rendering
 * dependency; the Ink root component (a later build-sequence step) is the
 * only thing that imports React/Ink, and it drives this reducer rather than
 * duplicating its logic.
 */

import type { PermissionDecision } from '../../agent-runtimes/types.js';
import type {
  ChatDisplayEvent,
  NativeChatStatus,
} from '../deus-native-chat.js';
import {
  keyToPermissionDecision,
  type PermissionKeypress,
} from './deus-tui-permission-decision.js';

export type TranscriptEntryKind =
  'user' | 'assistant' | 'tool' | 'progress' | 'error';

export interface TranscriptEntry {
  id: number;
  kind: TranscriptEntryKind;
  text: string;
}

export interface PermissionModalState {
  requestId: string;
  toolName: string;
  toolInputPreview: string;
}

export interface CommandPaletteState {
  open: boolean;
}

export interface TuiState {
  transcript: TranscriptEntry[];
  input: string;
  permission: PermissionModalState | undefined;
  palette: CommandPaletteState;
  status: NativeChatStatus | undefined;
}

export type TuiAction =
  | { type: 'input_change'; value: string }
  | { type: 'submit_input' }
  | { type: 'display_event'; event: ChatDisplayEvent }
  | { type: 'status_updated'; status: NativeChatStatus }
  | { type: 'open_palette' }
  | { type: 'close_palette' }
  | { type: 'permission_keypress'; input: string; key: PermissionKeypress };

export interface TuiReduceResult {
  state: TuiState;
  /**
   * Set only when a `permission_keypress` action resolves a decision. This
   * reducer never performs I/O (no transport call, no timers) — the caller
   * (the Ink app, a later build-sequence step) is responsible for sending
   * the decision to the transport and for the actual `allow_always`
   * persistence, which is Track A's concern, not this reducer's.
   */
  permissionDecision?: PermissionDecision;
}

export function createInitialTuiState(): TuiState {
  return {
    transcript: [],
    input: '',
    permission: undefined,
    palette: { open: false },
    status: undefined,
  };
}

function appendEntry(
  state: TuiState,
  kind: TranscriptEntryKind,
  text: string,
): TuiState {
  return {
    ...state,
    transcript: [
      ...state.transcript,
      { id: state.transcript.length, kind, text },
    ],
  };
}

function reduceDisplayEvent(
  state: TuiState,
  event: ChatDisplayEvent,
): TuiState {
  switch (event.kind) {
    case 'assistant_text':
      return appendEntry(state, 'assistant', event.text);
    case 'tool_use':
      return appendEntry(state, 'tool', event.label);
    case 'progress':
      return appendEntry(state, 'progress', event.text);
    case 'permission_request':
      // Modal state, not a transcript line — PermissionModal.tsx (a later
      // step) renders this separately from the scrolling log.
      return {
        ...state,
        permission: {
          requestId: event.requestId,
          toolName: event.toolName,
          toolInputPreview: event.toolInputPreview,
        },
      };
    case 'assistant_done':
      // Turn-boundary marker only; nothing to append.
      return state;
    case 'chat_error':
      return appendEntry(state, 'error', event.message);
    default: {
      const unhandled: never = event;
      void unhandled;
      return state;
    }
  }
}

/**
 * Reduce one action against the current state. Pure: identical inputs
 * always produce an identical output, no I/O, no timers, no randomness.
 */
export function tuiReduce(state: TuiState, action: TuiAction): TuiReduceResult {
  switch (action.type) {
    case 'input_change':
      return { state: { ...state, input: action.value } };
    case 'submit_input': {
      const trimmed = state.input.trim();
      const withEntry =
        trimmed === '' ? state : appendEntry(state, 'user', trimmed);
      return {
        state: { ...withEntry, input: '', palette: { open: false } },
      };
    }
    case 'display_event':
      return { state: reduceDisplayEvent(state, action.event) };
    case 'status_updated':
      return { state: { ...state, status: action.status } };
    case 'open_palette':
      return { state: { ...state, palette: { open: true } } };
    case 'close_palette':
      return { state: { ...state, palette: { open: false } } };
    case 'permission_keypress': {
      if (!state.permission) return { state };
      const decision = keyToPermissionDecision(action.input, action.key);
      if (decision === undefined) return { state };
      return {
        state: { ...state, permission: undefined },
        permissionDecision: decision,
      };
    }
    default: {
      const unhandled: never = action;
      void unhandled;
      return { state };
    }
  }
}
