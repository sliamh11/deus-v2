/**
 * Entry-point tests for `deus tui` (Track B step 3): non-TTY refusal,
 * discovery-record failure handling, and transport construction on the TTY
 * path — all via the injectable `TuiEntryDeps` seam, no live daemon and no
 * Ink render (this build-sequence step deliberately does not build the Ink
 * app yet; `launchApp` is faked here exactly the way it will later be
 * supplied by the real Ink entrypoint).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { CHAT_UNAVAILABLE_MESSAGE } from '../deus-native-chat-client.js';
import { NATIVE_CHAT_PROTOCOL_VERSION } from '../deus-native-chat.js';
import {
  runTuiEntry,
  TUI_NON_TTY_MESSAGE,
  type TuiEntryDeps,
} from './deus-tui-entry.js';

function fakeErrorOutput() {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    chunks,
  };
}

function writeDiscoveryRecord(overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-tui-entry-'));
  const file = path.join(dir, 'native-chat.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: NATIVE_CHAT_PROTOCOL_VERSION,
      pid: 1234,
      host: '127.0.0.1',
      port: 65535, // deliberately unreachable — no live daemon in unit tests
      token: 'test-token-0123456789abcdef0123456789', // >=32 chars, parseDiscoveryRecord requires it
      ...overrides,
    }),
  );
  return file;
}

function baseDeps(overrides: Partial<TuiEntryDeps> = {}): TuiEntryDeps {
  const { stream } = fakeErrorOutput();
  return {
    isTTY: true,
    errorOutput: stream,
    discoveryPath: writeDiscoveryRecord(),
    cwd: process.cwd(),
    ...overrides,
  };
}

describe('runTuiEntry — non-TTY refusal', () => {
  it('refuses immediately, never reads the discovery record or launches anything', async () => {
    const { stream, chunks } = fakeErrorOutput();
    let launchCalled = false;
    const code = await runTuiEntry({
      isTTY: false,
      errorOutput: stream,
      discoveryPath: '/nonexistent/path/does-not-matter.json',
      cwd: process.cwd(),
      launchApp: async () => {
        launchCalled = true;
        return 0;
      },
    });
    expect(code).toBe(1);
    expect(chunks.join('')).toBe(`${TUI_NON_TTY_MESSAGE}\n`);
    expect(launchCalled).toBe(false);
  });
});

describe('runTuiEntry — discovery record', () => {
  it('fails closed with CHAT_UNAVAILABLE_MESSAGE when no discovery file exists', async () => {
    const { stream, chunks } = fakeErrorOutput();
    const code = await runTuiEntry(
      baseDeps({
        errorOutput: stream,
        discoveryPath: path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), 'deus-tui-entry-missing-')),
          'native-chat.json',
        ),
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toBe(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
  });

  it('fails closed on a malformed/mismatched-version record', async () => {
    const { stream, chunks } = fakeErrorOutput();
    const code = await runTuiEntry(
      baseDeps({
        errorOutput: stream,
        discoveryPath: writeDiscoveryRecord({ version: 999 }),
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toBe(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
  });
});

describe('runTuiEntry — transport construction on the TTY path', () => {
  it('constructs a transport from a valid discovery record and hands it to launchApp', async () => {
    let receivedCwd: string | undefined;
    let sawTransport = false;
    const code = await runTuiEntry(
      baseDeps({
        cwd: '/some/project/dir',
        onTransportReady: (transport) => {
          sawTransport = Boolean(transport);
        },
        launchApp: async (transport, cwd) => {
          receivedCwd = cwd;
          expect(transport).toBeDefined();
          return 0;
        },
      }),
    );
    expect(code).toBe(0);
    expect(sawTransport).toBe(true);
    expect(receivedCwd).toBe('/some/project/dir');
  });

  it('surfaces a launchApp rejection as exit code 1 with an error message', async () => {
    const { stream, chunks } = fakeErrorOutput();
    const code = await runTuiEntry(
      baseDeps({
        errorOutput: stream,
        launchApp: async () => {
          throw new Error('render exploded');
        },
      }),
    );
    expect(code).toBe(1);
    expect(chunks.join('')).toContain('render exploded');
  });

  it('defaults to the real Ink launcher (launchTuiApp) when no launchApp is supplied — fails closed against an unreachable daemon', async () => {
    // No launchApp override: this exercises the REAL launchTuiApp, now
    // sourced from tui-v2/AppContainer.tsx (build-sequence step 10 of the
    // tui-v2 fork plan repointed this file's default launchApp here, from
    // the retired tui/deus-tui-app.tsx). baseDeps()'s discovery record
    // deliberately points at an unreachable port (see writeDiscoveryRecord's
    // own comment), so launchTuiApp's pre-render transport.status()
    // liveness check fails and it returns 1 with CHAT_UNAVAILABLE_MESSAGE —
    // without ever calling Ink's render() — exactly mirroring runChatCli's
    // own startup check. (See tui-v2/AppContainer.tsx's module doc for why
    // launchTuiApp checks liveness before rendering.)
    const { stream, chunks } = fakeErrorOutput();
    const code = await runTuiEntry(baseDeps({ errorOutput: stream }));
    expect(code).toBe(1);
    expect(chunks.join('')).toBe(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
  });
});
