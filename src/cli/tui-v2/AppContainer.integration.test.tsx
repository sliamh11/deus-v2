/**
 * App-level integration test for `tui-v2` (build-sequence step 11 of
 * `~/.claude/plans/deus-tui-gemini-fork.md`), rendering the REAL
 * `<AppContainer>` tree (bridge + reducer + `App`/`PermissionModal`/
 * `Composer`, no mocks below the transport boundary) against a fake
 * `ChatTransport`, via `ink-testing-library` — the same DI seam and
 * `stdin.write`/`waitFor` harness pattern `tui/deus-tui-app.test.tsx`
 * already established for the retired v1 shell.
 *
 * What this proves, per the plan's "Verification" §3:
 * 1. A `permission_request` display event drives the modal open.
 * 2. Resolving it calls `transport.respondPermission` exactly once, with
 *    the decision the user actually selected.
 * 3. `allow_always` is visibly distinct from the other two options — not
 *    just "selected vs. not", but a persistent tint independent of cursor
 *    position (`PermissionModal.tsx`'s module doc: "regardless of cursor
 *    position").
 * 4. A SECOND identical tool call in the same fake session does NOT
 *    re-open the modal. The fake transport below deliberately simulates
 *    server-side `SessionAlwaysAllowGrants` suppression itself (a
 *    `grantedTools` set consulted before ever emitting a
 *    `permission_request` event) — this is the only way to test the real
 *    claim: that the UI has no client-side memory of its own and is
 *    simply never asked twice, rather than the UI silently swallowing a
 *    second request it actually received.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import chalk from 'chalk';

import type { PermissionDecision } from '../../agent-runtimes/types.js';
import type {
  ChatDisplayEvent,
  NativeChatStatus,
} from '../deus-native-chat.js';
import type { ChatTransport } from '../deus-native-chat-client.js';
import { AppContainer } from './AppContainer.js';

// This test's assertion 3 (below) distinguishes "Always allow" / "Deny" /
// "Allow once" by the ANSI color escape each is actually rendered with —
// but Ink's `<Text color>` renders through the process-wide `chalk`
// singleton (`ink/build/colorize.js`, `ink/build/components/Text.js` both
// `import chalk from 'chalk'`), and chalk auto-detects its color level ONCE
// from the REAL process's stdio, not from the in-memory `Stdout`
// `ink-testing-library` hands to the tree under test — chalk's vendored
// `supports-color` short-circuits to level 0 whenever the real stream isn't
// a TTY and no `FORCE_COLOR` is set, before any CI-env-var or platform
// check even runs. On an interactive dev shell (a real TTY, or one that
// exports `FORCE_COLOR`) this is invisible; on a CI runner's non-
// interactive, piped stdout it isn't, and `lastAnsiColorBefore` below
// returns `''` for all three labels, so `alwaysAllowColor`/`denyColor`/
// `allowOnceColor` all compare equal — reproduced directly (locally, with
// `FORCE_COLOR`/`COLORTERM`/`TERM` unset, matching a bare CI shell) as the
// exact `expected '' not to be ''` failure this test hit on Windows CI; the
// same mechanism (verified the same way) explains
// `tui-v2/utils/CodeColorizer.test.tsx`'s sibling failure — see that file's
// own comment for the full chalk/supports-color trace. `chalk.level` is a
// live, mutable property real chalk-based callers read at EACH call, so
// forcing it here makes this test assert what it actually means to test —
// that the three permission choices render in genuinely different colors —
// instead of accidentally asserting a property of the calling process's
// terminal.
beforeAll(() => {
  chalk.level = 3;
});

// Several sequential waitFor() calls, each with its own 5s budget, can
// together exceed Vitest's 5s default per-test timeout even though every
// individual predicate here resolves in single-digit ms under normal
// conditions — same headroom rationale as tui/deus-tui-app.test.tsx's
// identical vi.setConfig call.
vi.setConfig({ testTimeout: 20_000 });

const SESSION_ID = '55555555-5555-5555-8555-555555555555';

function fakeStatus(): NativeChatStatus {
  return {
    backend: 'deus-native',
    mode: 'normal',
    permissionProfile: 'default',
    sessionId: SESSION_ID,
    state: 'new',
    output: 'buffered',
  };
}

interface RespondCall {
  requestId: string;
  decision: PermissionDecision;
}

/**
 * Simulates the daemon's real `SessionAlwaysAllowGrants` behavior
 * client-side ONLY inside this fake, so the test can observe the
 * consequence (no second `permission_request` event) without the real
 * daemon. `grantedTools` is consulted by `turn()` BEFORE it ever emits a
 * `permission_request` — exactly mirroring where the real suppression
 * lives (server-side, before the event reaches the wire), not something
 * `AppContainer`/`deus-chat-stream-bridge.ts`/`deus-tui-state.ts` do or
 * could do themselves.
 */
function fakeTransport() {
  const grantedTools = new Set<string>();
  const respondCalls: RespondCall[] = [];
  let turnCount = 0;

  const transport: ChatTransport = {
    async turn(_prompt, _cwd, onEvent) {
      turnCount += 1;
      const n = turnCount;
      await onEvent({ kind: 'tool_use', label: 'bash("ls -la")' });
      if (!grantedTools.has('bash')) {
        const event: ChatDisplayEvent = {
          kind: 'permission_request',
          requestId: `req-${n}`,
          toolName: 'bash',
          toolInputPreview: 'ls -la',
        };
        await onEvent(event);
      }
      await onEvent({ kind: 'assistant_text', text: `turn${n} complete` });
      await onEvent({ kind: 'assistant_done' });
    },
    async respondPermission(requestId, decision) {
      // No `await` before this runs: the real network call is genuinely
      // async in production, but nothing here needs to simulate latency —
      // what matters for the "second identical call is suppressed"
      // assertion is that `grantedTools` is updated deterministically
      // before the second `turn()` call is ever made, which the test's
      // own sequencing (typing the second line only after this resolves)
      // already guarantees regardless of timing.
      respondCalls.push({ requestId, decision });
      if (decision === 'allow_always') grantedTools.add('bash');
    },
    async setPlanMode() {
      return fakeStatus();
    },
    async status() {
      return fakeStatus();
    },
    async close() {},
  };

  return {
    transport,
    respondCalls,
    grantedTools,
    get turnCount() {
      return turnCount;
    },
  };
}

async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * A real (non-zero-delay) wait. Confirmed directly (isolating this from
 * every other variable in the harness, including swapping a polling
 * `waitFor` for a flat delay with everything else held constant): what
 * matters here is genuine elapsed WALL-CLOCK time, not enqueued
 * microtasks/0ms macrotasks — several consecutive 0ms `tick()`s between a
 * keypress and the next one were NOT reliably enough for the next keypress
 * (in particular, one landing right after `PermissionModal` first mounts,
 * e.g. the arrow-key move) to be received at all, while an otherwise
 * identical sequence with a real ~100ms gap was reliable every run. This
 * reproduced identically against the isolated `<PermissionModal>` in a
 * bare harness too, so it is not specific to `AppContainer`'s wiring. Not
 * fully root-caused beyond that finding (plausibly `useInput`'s effect,
 * whose deps include the inline, identity-changing `onKeypress` handler,
 * needs a real macrotask boundary to finish its cleanup+resubscribe before
 * `ink-testing-library`'s fake `Stdin`'s single-slot `read()` reliably
 * delivers the next write) — flagged here rather than asserted as fact,
 * per this repo's verification rules. Real terminal input never arrives
 * this close together in practice, so — like `typeText`'s per-character
 * tick above — this is a test-harness-only concern.
 */
async function settle(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Writes `text` one character at a time with an event-loop tick between
 * each `stdin.write` — required here (confirmed directly against BOTH
 * `Composer.tsx` and the retired `tui/components/InputLine.tsx`: this is a
 * general characteristic of this Ink+React19+`ink-testing-library`
 * combination, not something specific to either component). Writing
 * several characters back-to-back in the same synchronous tick races
 * `latest.current` (the ref both components' stable `useInput` handler
 * reads its current `value` off) against React's own state-update flush —
 * without a tick between writes, later characters read a stale `value`
 * and overwrite rather than append. `tui/deus-tui-app.test.tsx`'s existing
 * `typeText` helper doesn't hit this only because every string it types
 * happens to be short enough (2 chars) to not expose it — confirmed by
 * reproducing the same drop against the OLD `<App>` component with a
 * longer string. Real terminal input is never actually synchronous like
 * this (physical keystrokes always have real time, and therefore event-loop
 * ticks, between them), so this is a test-harness-only concern, not a
 * production input-handling bug in either component.
 */
async function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(1);
  }
}

const ARROW_DOWN = `${String.fromCharCode(0x1b)}[B`;

afterEach(() => {
  cleanup();
});

describe('<AppContainer> — permission modal integration (fake ChatTransport)', () => {
  it(
    'opens the modal on permission_request, resolves allow_always with exactly one ' +
      'respondPermission call, renders allow_always distinctly, and does not ' +
      're-open the modal for a second identical tool call once server-side-granted',
    async () => {
      const fake = fakeTransport();
      const instance = render(
        <AppContainer
          transport={fake.transport}
          cwd="/client/cwd"
          initialStatus={fakeStatus()}
          onExit={vi.fn()}
        />,
      );
      await tick();

      // --- Turn 1: first bash call, nothing granted yet -----------------
      await typeText(instance.stdin, 'run it');
      instance.stdin.write('\r');

      await waitFor(
        () => (instance.lastFrame() ?? '').includes('Permission requested'),
        'permission modal shown for turn 1',
      );
      // See settle()'s doc comment: the very first keypress PermissionModal
      // receives after it mounts needs a real elapsed-time gap, not just a
      // predicate-satisfied `waitFor` return (which can resolve within 1-2ms
      // of the modal appearing).
      await settle();

      // --- Assertion 3: allow_always is visibly distinct -----------------
      // Cursor is still at index 0 ("Allow once") at this point — neither
      // "Always allow" nor "Deny" is selected, so any color difference
      // between them is the PERSISTENT tint design decision #3's module
      // doc describes ("regardless of cursor position"), not just
      // selected-vs-unselected styling.
      const rawFrameBeforeMove = instance.lastFrame() ?? '';
      const alwaysAllowColor = lastAnsiColorBefore(
        rawFrameBeforeMove,
        'Always allow',
      );
      const denyColor = lastAnsiColorBefore(rawFrameBeforeMove, 'Deny');
      const allowOnceColor = lastAnsiColorBefore(
        rawFrameBeforeMove,
        'Allow once',
      );
      expect(alwaysAllowColor).not.toBe(denyColor);
      expect(alwaysAllowColor).not.toBe(allowOnceColor);

      // --- Move to "Always allow" (index 1) and resolve -------------------
      // A settle() between the two keypresses for the same reason described
      // above — without it, the Enter keypress can race the arrow-key's
      // state update and resolve against the still-stale cursorIndex.
      instance.stdin.write(ARROW_DOWN);
      await settle();
      instance.stdin.write('\r');

      await waitFor(
        () => (instance.lastFrame() ?? '').includes('turn1 complete'),
        'turn 1 resumed and completed after the permission decision',
      );

      // --- Assertion 2: exactly one respondPermission call, correct decision
      expect(fake.respondCalls).toEqual([
        { requestId: 'req-1', decision: 'allow_always' },
      ]);
      expect(instance.lastFrame() ?? '').not.toContain('Permission requested');

      // Let busy/onBusyChange settle fully before the next keystroke —
      // Composer's useInput is gated `isActive: !busy`, so typing into a
      // still-busy composer would silently drop characters (mirrors the
      // caution `tui/deus-tui-app.test.tsx`'s module doc already documents
      // for Ink's async effect-subscription timing) — and per settle()'s
      // own doc comment, a real elapsed-time gap, not just queued 0ms
      // ticks, is what's actually reliable here.
      await settle();

      // --- Turn 2: identical tool call, now server-side-granted ----------
      await typeText(instance.stdin, 'again');
      instance.stdin.write('\r');

      await waitFor(
        () => (instance.lastFrame() ?? '').includes('turn2 complete'),
        'turn 2 completed without ever pausing for permission',
      );

      // --- Assertion 4: no second modal, no second respondPermission call
      expect(instance.lastFrame() ?? '').not.toContain('Permission requested');
      expect(fake.respondCalls).toHaveLength(1);
      expect(fake.turnCount).toBe(2);
    },
  );
});

/**
 * Finds the last SGR color escape sequence (`ESC[...m`) preceding the
 * first occurrence of `label` in `raw` (a non-stripped `lastFrame()`
 * output) — i.e. the color the label was actually rendered in. Used
 * instead of asserting a specific hex/ANSI value (which would over-couple
 * the test to the current theme's exact palette) to prove two labels were
 * rendered in genuinely different colors.
 */
function lastAnsiColorBefore(raw: string, label: string): string {
  const idx = raw.indexOf(label);
  if (idx === -1) {
    throw new Error(`label not found in frame: ${label}\n---\n${raw}`);
  }
  const before = raw.slice(0, idx);
  const escapePattern = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
  const matches = before.match(escapePattern) ?? [];
  return matches[matches.length - 1] ?? '';
}
