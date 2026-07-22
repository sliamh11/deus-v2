/**
 * Plain-Vitest unit tests for the pure `deus tui` reducer — no Ink, no
 * transport, no I/O. Covers each display-event kind, local UI actions
 * (submit input, palette open/close, permission keypress), and the
 * permission-keypress → decision hand-off contract (the reducer resolves
 * the decision and closes the modal, but never sends anything itself).
 */

import { describe, expect, it } from 'vitest';

import type { ChatDisplayEvent } from '../deus-native-chat.js';
import {
  createInitialTuiState,
  tuiReduce,
  type TuiState,
} from './deus-tui-state.js';

describe('createInitialTuiState', () => {
  it('starts empty with the palette closed and no active permission modal', () => {
    const state = createInitialTuiState();
    expect(state).toEqual({
      transcript: [],
      input: '',
      permission: undefined,
      palette: { open: false },
      status: undefined,
    });
  });
});

describe('tuiReduce — input_change / submit_input', () => {
  it('tracks the controlled input value', () => {
    const { state } = tuiReduce(createInitialTuiState(), {
      type: 'input_change',
      value: 'hello',
    });
    expect(state.input).toBe('hello');
  });

  it('appends a trimmed user transcript entry on submit and clears input', () => {
    const typed = tuiReduce(createInitialTuiState(), {
      type: 'input_change',
      value: '  hello world  ',
    }).state;
    const { state } = tuiReduce(typed, { type: 'submit_input' });
    expect(state.transcript).toEqual([
      { id: 0, kind: 'user', text: 'hello world' },
    ]);
    expect(state.input).toBe('');
  });

  it('does not append an empty entry for whitespace-only submit', () => {
    const typed = tuiReduce(createInitialTuiState(), {
      type: 'input_change',
      value: '   ',
    }).state;
    const { state } = tuiReduce(typed, { type: 'submit_input' });
    expect(state.transcript).toEqual([]);
    expect(state.input).toBe('');
  });

  it('closes the command palette on submit', () => {
    const opened = tuiReduce(createInitialTuiState(), {
      type: 'open_palette',
    }).state;
    const { state } = tuiReduce(opened, { type: 'submit_input' });
    expect(state.palette).toEqual({ open: false });
  });
});

describe('tuiReduce — display_event', () => {
  const cases: Array<{
    event: ChatDisplayEvent;
    expected: TuiState['transcript'];
  }> = [
    {
      event: { kind: 'assistant_text', text: 'hi there' },
      expected: [{ id: 0, kind: 'assistant', text: 'hi there' }],
    },
    {
      event: { kind: 'tool_use', label: 'Using web_search…' },
      expected: [{ id: 0, kind: 'tool', text: 'Using web_search…' }],
    },
    {
      event: { kind: 'progress', text: 'thinking…' },
      expected: [{ id: 0, kind: 'progress', text: 'thinking…' }],
    },
    {
      event: { kind: 'chat_error', message: 'boom' },
      expected: [{ id: 0, kind: 'error', text: 'boom' }],
    },
  ];

  it.each(cases)(
    'maps $event.kind to a transcript entry',
    ({ event, expected }) => {
      const { state } = tuiReduce(createInitialTuiState(), {
        type: 'display_event',
        event,
      });
      expect(state.transcript).toEqual(expected);
    },
  );

  it('assistant_done is a no-op boundary marker (no transcript entry)', () => {
    const { state } = tuiReduce(createInitialTuiState(), {
      type: 'display_event',
      event: { kind: 'assistant_done' },
    });
    expect(state.transcript).toEqual([]);
  });

  it('permission_request sets modal state, not a transcript entry', () => {
    const { state } = tuiReduce(createInitialTuiState(), {
      type: 'display_event',
      event: {
        kind: 'permission_request',
        requestId: 'req-1',
        toolName: 'web_search',
        toolInputPreview: 'query: "weather"',
      },
    });
    expect(state.transcript).toEqual([]);
    expect(state.permission).toEqual({
      requestId: 'req-1',
      toolName: 'web_search',
      toolInputPreview: 'query: "weather"',
    });
  });

  it('status_updated stores the latest status', () => {
    const status = {
      backend: 'deus-native' as const,
      mode: 'normal' as const,
      permissionProfile: 'default',
      sessionId: 'sess-1',
      state: 'resumed' as const,
      output: 'buffered' as const,
    };
    const { state } = tuiReduce(createInitialTuiState(), {
      type: 'status_updated',
      status,
    });
    expect(state.status).toEqual(status);
  });
});

describe('tuiReduce — command palette', () => {
  it('open_palette / close_palette toggle palette.open', () => {
    const opened = tuiReduce(createInitialTuiState(), {
      type: 'open_palette',
    }).state;
    expect(opened.palette).toEqual({ open: true });
    const closed = tuiReduce(opened, { type: 'close_palette' }).state;
    expect(closed.palette).toEqual({ open: false });
  });
});

describe('tuiReduce — permission_keypress', () => {
  function withPendingPermission(): TuiState {
    return tuiReduce(createInitialTuiState(), {
      type: 'display_event',
      event: {
        kind: 'permission_request',
        requestId: 'req-1',
        toolName: 'web_fetch',
        toolInputPreview: 'url: "https://example.com"',
      },
    }).state;
  }

  it('is a no-op when no permission is pending', () => {
    const result = tuiReduce(createInitialTuiState(), {
      type: 'permission_keypress',
      input: 'y',
      key: {},
    });
    expect(result.state.permission).toBeUndefined();
    expect(result.permissionDecision).toBeUndefined();
  });

  it('resolves allow_once, closes the modal, and surfaces the decision — never sends it itself', () => {
    const pending = withPendingPermission();
    const result = tuiReduce(pending, {
      type: 'permission_keypress',
      input: 'y',
      key: {},
    });
    expect(result.permissionDecision).toBe('allow_once');
    expect(result.state.permission).toBeUndefined();
  });

  it('resolves allow_always from the full word', () => {
    const pending = withPendingPermission();
    const result = tuiReduce(pending, {
      type: 'permission_keypress',
      input: 'always',
      key: { return: true },
    });
    expect(result.permissionDecision).toBe('allow_always');
    expect(result.state.permission).toBeUndefined();
  });

  it('resolves deny on bare Enter (fail-closed)', () => {
    const pending = withPendingPermission();
    const result = tuiReduce(pending, {
      type: 'permission_keypress',
      input: '',
      key: { return: true },
    });
    expect(result.permissionDecision).toBe('deny');
    expect(result.state.permission).toBeUndefined();
  });

  it('keeps the modal open and the decision unresolved for unrecognized input', () => {
    const pending = withPendingPermission();
    const result = tuiReduce(pending, {
      type: 'permission_keypress',
      input: 'maybe',
      key: { return: true },
    });
    expect(result.permissionDecision).toBeUndefined();
    expect(result.state.permission).toEqual(pending.permission);
  });
});
