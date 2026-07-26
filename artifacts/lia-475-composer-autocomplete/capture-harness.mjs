#!/usr/bin/env -S npx tsx
/**
 * LIA-475 visual-verification capture harness.
 *
 * Boots the REAL `tui-v2` Ink component tree (`AppContainer.tsx`'s
 * `launchTuiApp`) against a FAKE, in-memory `ChatTransport` — the same
 * test-double pattern `AppContainer.integration.test.tsx` already uses for
 * this repo's own automated tests (see that file's header). This is
 * deliberate and load-bearing for the daemon-safety note in this track's
 * dispatch: it demonstrates the REAL, just-implemented Composer/
 * autocomplete/highlight code rendering in a REAL terminal, with ZERO
 * network calls to the actual production `deus-native-chat` daemon
 * (pid recorded in `~/.config/deus-v2/native-chat.json`) that is already
 * serving live WhatsApp/Telegram/credential-proxy traffic on this host.
 * `transport.status()`/`turn()`/`respondPermission()`/`close()` below never
 * touch a socket — they resolve synchronously/immediately from an in-memory
 * object, exactly mirroring what the fake in `AppContainer.integration.
 * test.tsx` does.
 *
 * `cwd` is intentionally the real worktree checkout root (not a scratch
 * temp dir) so the `@`-mention autocomplete's directory-listing scenario
 * demonstrates real, cwd-backed `fs.readdir` results (e.g. `@src/cli`
 * really lists this repo's real `src/cli/` directory) rather than a
 * fabricated fixture tree — this is read-only (`fs.readdir` only, never a
 * write) so it is safe to point at the real checkout.
 *
 * Driven externally via `tmux send-keys` against the pty this process runs
 * in, with an `asciinema rec` attached to the same tmux session recording
 * the terminal — see `README.md` in this directory for the exact capture
 * commands used to produce `before-composer-live-typing.*` and
 * `after-composer-live-typing.*`.
 */

import { render as inkRender } from 'ink';
import React from 'react';

import { AppContainer } from '../../src/cli/tui-v2/AppContainer.js';

const fakeStatus = () => ({
  backend: 'deus-native',
  mode: 'normal',
  permissionProfile: 'default',
  sessionId: '00000000-0000-0000-0000-000000000000',
  state: 'new',
  output: 'buffered',
});

/** Deliberately minimal — no real transport/socket. See module doc. */
const fakeTransport = {
  async turn(_prompt, _cwd, onEvent) {
    await onEvent({ kind: 'assistant_text', text: '(capture-harness: no real backend wired — this run only exercises Composer input handling.)' });
    await onEvent({ kind: 'assistant_done' });
  },
  async respondPermission() {},
  async setPlanMode() {
    return fakeStatus();
  },
  async status() {
    return fakeStatus();
  },
  async close() {},
};

const instance = inkRender(
  React.createElement(AppContainer, {
    transport: fakeTransport,
    cwd: process.cwd(),
    initialStatus: fakeStatus(),
    onExit: () => instance.unmount(),
  }),
);

await instance.waitUntilExit();
