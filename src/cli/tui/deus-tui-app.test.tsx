/**
 * Component-level tests for `deus tui`'s root `<App>` (Track B step 14 of
 * /Users/liam10play/.claude/plans/expressive-foraging-reef.md) via
 * `ink-testing-library`'s `render()`/`lastFrame()`, with a fake
 * `ChatTransport` injected through the same DI seam
 * `deus-native-chat-client.test.ts` already uses for the readline client —
 * these tests assert the SAME behavioral contract that file's
 * `runChatCli` tests assert (turn dispatch, /status, /plan, /exit, a
 * permission round-trip), just against the Ink rendering layer instead of
 * readline.
 *
 * `mountApp()` awaits one macrotask tick after `render()` before returning:
 * Ink's `useInput` subscribes its keystroke listener from a passive effect,
 * which React schedules asynchronously after the initial commit (not
 * synchronously within `render()`'s call stack) — a keystroke written
 * before that effect has flushed is silently dropped (verified directly:
 * without this tick, the very first character of the very first typed
 * string in every interactive test below was lost). This is a test-harness
 * timing fact about Ink's initial mount, not a bug in the components under
 * test — see `InputLine.tsx`'s doc comment for the RELATED (but distinct)
 * production bug this session found and fixed, where a per-render handler
 * identity caused *later* keystrokes to drop even after mount had settled.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';

import type { PermissionDecision } from '../../agent-runtimes/types.js';
import type {
  ChatDisplayEvent,
  NativeChatStatus,
} from '../deus-native-chat.js';
import {
  CHAT_UNAVAILABLE_MESSAGE,
  type ChatTransport,
} from '../deus-native-chat-client.js';
import { App, launchTuiApp } from './deus-tui-app.js';

afterEach(() => {
  cleanup();
});

const SESSION_ID = '44444444-4444-4444-8444-444444444444';

function makeStatus(
  overrides: Partial<NativeChatStatus> = {},
): NativeChatStatus {
  return {
    backend: 'deus-native',
    mode: 'normal',
    permissionProfile: 'default',
    sessionId: SESSION_ID,
    state: 'resumed',
    output: 'buffered',
    ...overrides,
  };
}

interface FakeTransportOptions {
  status?: NativeChatStatus;
  turnEvents?: ChatDisplayEvent[][];
  failPermissionResponse?: boolean;
}

function fakeTransport(options: FakeTransportOptions = {}) {
  const turns: string[] = [];
  const permissionResponses: Array<{
    requestId: string;
    decision: PermissionDecision;
  }> = [];
  const planTransitions: boolean[] = [];
  const baseline = options.status?.permissionProfile ?? 'default';
  let currentStatus = options.status ?? makeStatus();
  let closes = 0;

  const transport: ChatTransport = {
    async respondPermission(requestId, decision) {
      if (options.failPermissionResponse) throw new Error('unavailable');
      permissionResponses.push({ requestId, decision });
    },
    async status() {
      return currentStatus;
    },
    async setPlanMode(enabled) {
      planTransitions.push(enabled);
      currentStatus = {
        ...currentStatus,
        mode: enabled ? 'plan' : 'normal',
        permissionProfile: enabled ? 'read-only' : baseline,
      };
      return currentStatus;
    },
    async turn(prompt, _cwd, onEvent) {
      turns.push(prompt);
      const script =
        options.turnEvents?.[
          Math.min(turns.length - 1, (options.turnEvents?.length ?? 1) - 1)
        ] ?? defaultTurnEvents(prompt);
      for (const event of script) {
        await Promise.resolve();
        await onEvent(event);
      }
    },
    async close() {
      closes += 1;
    },
  };

  return {
    transport,
    turns,
    permissionResponses,
    planTransitions,
    get closes() {
      return closes;
    },
  };
}

function defaultTurnEvents(prompt: string): ChatDisplayEvent[] {
  return [
    { kind: 'assistant_text', text: `echo:${prompt}` },
    { kind: 'assistant_done' },
  ];
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `render()` + one settle tick — see this file's module doc for why. */
async function mountApp(
  node: ReactElement,
): Promise<ReturnType<typeof render>> {
  const instance = render(node);
  await tick();
  return instance;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): void {
  for (const char of text) stdin.write(char);
}

describe('<App> — startup', () => {
  it('renders the status header fields and the resumed-session notice', async () => {
    const fake = fakeTransport();
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('deus-native');
    expect(frame).toContain('normal');
    expect(frame).toContain('default');
    expect(frame).toContain(SESSION_ID);
    expect(frame).toContain('resumed');
    expect(frame).toContain('Resumed your previous conversation');
  });
});

describe('<App> — chat turns', () => {
  it('submits typed text as a turn and renders streamed assistant text', async () => {
    const fake = fakeTransport({
      turnEvents: [
        [
          { kind: 'assistant_text', text: 'hello there' },
          { kind: 'assistant_done' },
        ],
      ],
    });
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, 'hi');
    instance.stdin.write('\r');

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('hello there'),
      'streamed assistant text',
    );
    expect(fake.turns).toEqual(['hi']);
    expect(instance.lastFrame()).toContain('> hi');
  });
});

describe('<App> — local commands', () => {
  it('/status refreshes and appends the full diagnostic block without starting a turn', async () => {
    const fake = fakeTransport({ status: makeStatus({ output: 'streaming' }) });
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, '/status');
    instance.stdin.write('\r');

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('Output:  streaming'),
      'full status dump',
    );
    expect(fake.turns).toEqual([]);
  });

  it('/plan on switches to the read-only profile', async () => {
    const fake = fakeTransport();
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, '/plan on');
    instance.stdin.write('\r');

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('read-only'),
      'plan-mode profile switch',
    );
    expect(fake.planTransitions).toEqual([true]);
  });

  it('/exit calls onExit without starting a turn', async () => {
    const fake = fakeTransport();
    let exited = false;
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {
          exited = true;
        }}
      />,
    );

    typeText(instance.stdin, '/exit');
    instance.stdin.write('\r');

    await waitFor(() => exited, 'onExit invoked');
    expect(fake.turns).toEqual([]);
  });
});

describe('<App> — command palette', () => {
  it("'/' on an empty input line opens the palette, and Enter runs the fuzzy-selected command", async () => {
    const fake = fakeTransport({ status: makeStatus({ output: 'streaming' }) });
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    instance.stdin.write('/');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('Commands'),
      'palette open',
    );
    // '/' must have opened the palette, not been inserted into the input line.
    expect(instance.lastFrame()).not.toContain('> /');

    typeText(instance.stdin, 'stat'); // fuzzy-isolates "/status" among LOCAL_COMMANDS
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('/status'),
      'palette filtered to /status',
    );
    instance.stdin.write('\r');

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('Output:  streaming'),
      'selected /status command ran',
    );
    expect(fake.turns).toEqual([]);
  });
});

describe('<App> — permission modal', () => {
  it('blocks the turn on a permission_request, sends allow_once on "y", and resumes the stream', async () => {
    const fake = fakeTransport({
      turnEvents: [
        [
          {
            kind: 'permission_request',
            requestId: 'permission-1',
            toolName: 'web_search',
            toolInputPreview: '{"query":"weather"}',
          },
          { kind: 'assistant_text', text: 'turn continued' },
          { kind: 'assistant_done' },
        ],
      ],
    });
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, 'search please');
    instance.stdin.write('\r');

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('Permission requested'),
      'permission modal shown',
    );
    expect(instance.lastFrame()).toContain('web_search');

    // The turn must be BLOCKED on the permission answer — the event after
    // it in the script must not have rendered yet.
    expect(instance.lastFrame()).not.toContain('turn continued');

    instance.stdin.write('y');

    await waitFor(
      () => fake.permissionResponses.length > 0,
      'permission response sent',
    );
    expect(fake.permissionResponses).toEqual([
      { requestId: 'permission-1', decision: 'allow_once' },
    ]);

    await waitFor(
      () => (instance.lastFrame() ?? '').includes('turn continued'),
      'turn resumed after the answer',
    );
    expect(instance.lastFrame()).not.toContain('Permission requested');
  });

  it('denies fail-closed on a bare Enter', async () => {
    const fake = fakeTransport({
      turnEvents: [
        [
          {
            kind: 'permission_request',
            requestId: 'permission-2',
            toolName: 'web_fetch',
            toolInputPreview: '{"url":"https://example.com"}',
          },
          { kind: 'assistant_done' },
        ],
      ],
    });
    const instance = await mountApp(
      <App
        transport={fake.transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, 'fetch please');
    instance.stdin.write('\r');
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('Permission requested'),
      'permission modal shown',
    );

    instance.stdin.write('\r'); // bare Enter, no text typed

    await waitFor(
      () => fake.permissionResponses.length > 0,
      'permission response sent',
    );
    expect(fake.permissionResponses).toEqual([
      { requestId: 'permission-2', decision: 'deny' },
    ]);
  });
});

describe('<App> — busy gating', () => {
  it('disables the input line while a turn is in flight, never starting an overlapping turn', async () => {
    let releaseTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turnCalls = 0;
    const transport: ChatTransport = {
      async respondPermission() {},
      async status() {
        return makeStatus();
      },
      async setPlanMode() {
        return makeStatus();
      },
      async turn(_prompt, _cwd, onEvent) {
        turnCalls += 1;
        await gate;
        await onEvent({ kind: 'assistant_text', text: 'done waiting' });
        await onEvent({ kind: 'assistant_done' });
      },
      async close() {},
    };

    const instance = await mountApp(
      <App
        transport={transport}
        cwd="/client/cwd"
        initialStatus={makeStatus()}
        onExit={() => {}}
      />,
    );

    typeText(instance.stdin, 'first');
    instance.stdin.write('\r');
    await waitFor(() => turnCalls === 1, 'first turn started');

    // Attempt to type + submit again while the first turn is still in
    // flight — InputLine's useInput is inactive (isActive=false) during
    // `busy`, so this must have zero effect on the input line and must
    // NEVER trigger a second transport.turn() call.
    typeText(instance.stdin, 'second');
    instance.stdin.write('\r');
    expect(instance.lastFrame()).not.toContain('> second');
    expect(turnCalls).toBe(1);

    releaseTurn();
    await waitFor(
      () => (instance.lastFrame() ?? '').includes('done waiting'),
      'first turn completed',
    );
    expect(turnCalls).toBe(1);
  });
});

describe('launchTuiApp', () => {
  it('fails closed with CHAT_UNAVAILABLE_MESSAGE and never renders when the pre-flight status check fails', async () => {
    const chunks: string[] = [];
    const errorOutput = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    const transport: ChatTransport = {
      async respondPermission() {},
      async status() {
        throw new Error('daemon unreachable');
      },
      async setPlanMode() {
        return makeStatus();
      },
      async turn() {},
      async close() {},
    };

    const code = await launchTuiApp(transport, '/client/cwd', { errorOutput });

    expect(code).toBe(1);
    expect(chunks.join('')).toBe(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
  });
});
