/**
 * Plain-Vitest unit tests for `deus-chat-stream-bridge.ts`, per the plan's
 * build-sequence step 5: built and tested against a fake `ChatTransport`,
 * independent of any UI component (no Ink/React import anywhere in this
 * file).
 */

import { describe, expect, it, vi } from 'vitest';

import type { ChatTransport } from '../deus-native-chat-client.js';
import type { ChatDisplayEvent } from '../deus-native-chat.js';
import type { NativeChatStatus } from '../deus-native-chat.js';
import { DENY_TIMEOUT_MS } from '../../agent-runtimes/permission-registry.js';
import {
  createChatStreamBridge,
  type ChatStreamBridge,
} from './deus-chat-stream-bridge.js';
import { createInitialTuiState, type TuiState } from './deus-tui-state.js';

function fakeStatus(): NativeChatStatus {
  return {
    backend: 'deus-native',
    mode: 'normal',
    permissionProfile: 'default',
    sessionId: 's1',
    state: 'new',
    output: 'streaming',
  };
}

/** Minimal harness: plain closures standing in for React state, exactly the shape `ChatStreamBridgeDeps` asks for. */
function createHarness() {
  let state: TuiState = createInitialTuiState();
  const busyEvents: boolean[] = [];
  return {
    getState: () => state,
    setState: (next: TuiState) => {
      state = next;
    },
    onBusyChange: (busy: boolean) => busyEvents.push(busy),
    busyEvents,
    currentState: () => state,
  };
}

function wait(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createChatStreamBridge — happy-path streaming', () => {
  it('streams assistant_text/tool_use/progress/assistant_done into state via tuiReduce, and toggles busy around the turn', async () => {
    const harness = createHarness();
    const turnCalls: Array<{ prompt: string; cwd: string }> = [];
    const transport: ChatTransport = {
      async turn(prompt, cwd, onEvent) {
        turnCalls.push({ prompt, cwd });
        await onEvent({ kind: 'assistant_text', text: 'hi ' });
        await onEvent({ kind: 'tool_use', label: 'web_search("x")' });
        await onEvent({ kind: 'progress', text: 'searching...' });
        await onEvent({ kind: 'assistant_done' });
      },
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };

    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
      onBusyChange: harness.onBusyChange,
    });

    expect(bridge.isBusy()).toBe(false);
    const done = bridge.submitTurn('hello');
    expect(bridge.isBusy()).toBe(true);
    await done;
    expect(bridge.isBusy()).toBe(false);

    expect(turnCalls).toEqual([{ prompt: 'hello', cwd: '/work' }]);
    expect(harness.currentState().transcript).toEqual([
      { id: 0, kind: 'assistant', text: 'hi ' },
      { id: 1, kind: 'tool', text: 'web_search("x")' },
      { id: 2, kind: 'progress', text: 'searching...' },
    ]);
    expect(harness.busyEvents).toEqual([true, false]);
  });

  it('does not call transport.turn a second time while a turn is already in flight', async () => {
    const harness = createHarness();
    let resolveTurn: (() => void) | undefined;
    const turnCalls: string[] = [];
    const transport: ChatTransport = {
      async turn(prompt) {
        turnCalls.push(prompt);
        await new Promise<void>((resolve) => {
          resolveTurn = resolve;
        });
      },
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    const first = bridge.submitTurn('one');
    const second = bridge.submitTurn('two'); // should no-op: busy already true
    expect(turnCalls).toEqual(['one']);

    resolveTurn?.();
    await Promise.all([first, second]);
    expect(turnCalls).toEqual(['one']);
  });
});

describe('createChatStreamBridge — permission_request blocking', () => {
  it('pauses the event stream on permission_request until respondPermission resolves it, and unblocks synchronously (not waiting on the network response)', async () => {
    const harness = createHarness();
    const order: string[] = [];
    let respondPermissionResolve: (() => void) | undefined;
    const respondPermissionSpy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          respondPermissionResolve = resolve;
        }),
    );
    const transport: ChatTransport = {
      async turn(_prompt, _cwd, onEvent) {
        await onEvent({
          kind: 'permission_request',
          requestId: 'req-1',
          toolName: 'web_search',
          toolInputPreview: '{"query":"x"}',
        });
        order.push('after-permission-event');
        await onEvent({ kind: 'assistant_done' });
        order.push('after-done-event');
      },
      respondPermission: respondPermissionSpy,
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge: ChatStreamBridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    const turnPromise = bridge.submitTurn('search x');

    await wait(); // let the stream reach and pause on permission_request
    expect(harness.currentState().permission).toEqual({
      requestId: 'req-1',
      toolName: 'web_search',
      toolInputPreview: '{"query":"x"}',
      cursorIndex: 0,
    });
    expect(order).toEqual([]); // genuinely paused — nothing past the permission event yet
    expect(respondPermissionSpy).not.toHaveBeenCalled();

    // Cursor opens at index 0 ("Allow once"); Enter resolves it directly.
    bridge.respondPermission({ return: true });

    // Stream resumes immediately, before the fake network call settles.
    await wait();
    expect(order).toEqual(['after-permission-event', 'after-done-event']);
    expect(respondPermissionSpy).toHaveBeenCalledWith('req-1', 'allow_once');
    expect(harness.currentState().permission).toBeUndefined();

    respondPermissionResolve?.();
    await turnPromise;
  });

  it('leaves the modal open and the stream paused when a keypress only moves the cursor rather than resolving a decision', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const transport: ChatTransport = {
      async turn(_prompt, _cwd, onEvent) {
        await onEvent({
          kind: 'permission_request',
          requestId: 'req-2',
          toolName: 'edit_file',
          toolInputPreview: '{}',
        });
        order.push('resumed');
      },
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    const turnPromise = bridge.submitTurn('edit it');
    await wait();

    // Down arrow just moves the cursor to index 1 ("Always allow"): does not resolve.
    bridge.respondPermission({ downArrow: true });
    await wait();
    expect(order).toEqual([]);
    expect(harness.currentState().permission).toEqual(
      expect.objectContaining({ cursorIndex: 1 }),
    );
    expect(transport.respondPermission).not.toHaveBeenCalled();

    // Now Enter resolves whatever's currently highlighted (index 1 == allow_always).
    bridge.respondPermission({ return: true });
    await wait();
    expect(order).toEqual(['resumed']);
    expect(transport.respondPermission).toHaveBeenCalledWith(
      'req-2',
      'allow_always',
    );

    await turnPromise;
  });

  it('appends a chat_error with the DENY_TIMEOUT_MS message when transport.respondPermission rejects, without re-blocking the already-resumed turn', async () => {
    const harness = createHarness();
    const transport: ChatTransport = {
      async turn(_prompt, _cwd, onEvent) {
        await onEvent({
          kind: 'permission_request',
          requestId: 'req-3',
          toolName: 'web_fetch',
          toolInputPreview: '{}',
        });
        await onEvent({ kind: 'assistant_done' });
      },
      respondPermission: vi.fn(async () => {
        throw new Error('network down');
      }),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    const turnPromise = bridge.submitTurn('fetch it');
    await wait();
    // Move to index 2 ("Deny") and confirm.
    bridge.respondPermission({ downArrow: true });
    bridge.respondPermission({ downArrow: true });
    bridge.respondPermission({ return: true });
    await turnPromise;
    await wait();

    const errorEntry = harness
      .currentState()
      .transcript.find((entry) => entry.kind === 'error');
    expect(errorEntry?.text).toBe(
      `failed to send the permission response; this request will auto-deny in ${DENY_TIMEOUT_MS / 1_000}s.`,
    );
  });

  it('no-ops when respondPermission is called with no permission modal open', () => {
    const harness = createHarness();
    const transport: ChatTransport = {
      turn: vi.fn(async () => {}),
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    bridge.respondPermission({ return: true });
    expect(transport.respondPermission).not.toHaveBeenCalled();
  });
});

describe('createChatStreamBridge — turn failure', () => {
  it('dispatches a chat_error and resets busy when transport.turn rejects, without throwing', async () => {
    const harness = createHarness();
    const transport: ChatTransport = {
      turn: vi.fn(async () => {
        throw new Error('boom');
      }),
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
      onBusyChange: harness.onBusyChange,
    });

    await expect(bridge.submitTurn('hello')).resolves.toBeUndefined();
    expect(bridge.isBusy()).toBe(false);
    expect(harness.currentState().transcript).toEqual([
      {
        id: 0,
        kind: 'error',
        text: 'the chat request failed. Is the Deus service still running?',
      },
    ]);
    expect(harness.busyEvents).toEqual([true, false]);
  });
});

describe('createChatStreamBridge — event union coverage', () => {
  it('routes every ChatDisplayEvent kind through tuiReduce as expected', async () => {
    const harness = createHarness();
    const events: ChatDisplayEvent[] = [
      { kind: 'chat_error', message: 'oops' },
    ];
    const transport: ChatTransport = {
      async turn(_prompt, _cwd, onEvent) {
        for (const event of events) await onEvent(event);
      },
      respondPermission: vi.fn(async () => {}),
      setPlanMode: vi.fn(async () => fakeStatus()),
      status: vi.fn(async () => fakeStatus()),
      close: vi.fn(async () => {}),
    };
    const bridge = createChatStreamBridge({
      transport,
      cwd: '/work',
      getState: harness.getState,
      setState: harness.setState,
    });

    await bridge.submitTurn('trigger error');
    expect(harness.currentState().transcript).toEqual([
      { id: 0, kind: 'error', text: 'oops' },
    ]);
  });
});
