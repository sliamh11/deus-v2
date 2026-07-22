/**
 * `deus tui` process entrypoint (Track B of
 * LIA-471's spec,
 * deus-tui-ink-rendering branch). This is the compiled executable the
 * shell/PowerShell launchers will
 * `exec` into (mirroring `deus-cmd.sh`'s existing `chat)` case).
 *
 * Mirrors `deus-native-chat-client.ts`'s `main()`: reads the daemon's
 * discovery record and constructs the same `ChatTransport` HTTP client
 * (reused unchanged — this is a pure rendering-layer swap, zero protocol
 * changes, per the plan's Track B "Reused unchanged" note), and wires
 * SIGINT/exit codes the same way.
 *
 * Non-TTY refusal happens BEFORE any of that: `deus tui` is meaningless in
 * a non-interactive context (piped output, CI, scripted invocation), so it
 * refuses immediately with a clear message rather than reading the
 * discovery record or constructing a transport that nothing will render
 * against. `deus chat` remains the scriptable/CI-safe path.
 *
 * The real Ink root component is `tui-v2/AppContainer.tsx`'s `<AppContainer>`
 * (build-sequence step 10 of the `tui-v2` fork plan; formerly
 * `deus-tui-app.tsx`'s `<App>`, which this file pointed at before the
 * cutover). `launchTuiApp`, exported from `tui-v2/AppContainer.ts`, is the
 * default `launchApp` below — `TuiEntryDeps.launchApp`
 * stays an injectable seam so this file's entry/transport/refusal logic is
 * independently testable with a fake, exactly as it already was before
 * step 6 landed.
 */

import fs from 'fs';

import {
  createHttpChatTransport,
  CHAT_UNAVAILABLE_MESSAGE,
  type ChatTransport,
} from '../deus-native-chat-client.js';
import {
  nativeChatDiscoveryPath,
  parseDiscoveryRecord,
  type NativeChatDiscoveryRecord,
} from '../deus-native-chat.js';
import { launchTuiApp } from '../tui-v2/AppContainer.js';

export const TUI_NON_TTY_MESSAGE =
  'deus tui requires an interactive terminal; use `deus chat` for scripted/CI usage.';

/**
 * Launches the interactive Ink app and resolves the process exit code.
 * Defaults to `launchTuiApp` (`tui-v2/AppContainer.tsx`); overridden in tests with
 * a fake so `runTuiEntry`'s own logic is verifiable without a real TTY/Ink
 * render.
 */
export type LaunchTuiApp = (
  transport: ChatTransport,
  cwd: string,
) => Promise<number>;

export interface TuiEntryDeps {
  isTTY: boolean;
  errorOutput: NodeJS.WritableStream;
  discoveryPath: string;
  cwd: string;
  launchApp?: LaunchTuiApp;
  /**
   * Invoked with the constructed transport as soon as it's ready, before
   * `launchApp` is awaited — lets `main()` capture it for SIGINT handling
   * without this function needing to expose process-level concerns.
   */
  onTransportReady?: (transport: ChatTransport) => void;
}

/**
 * Testable core of the `deus tui` entrypoint. Resolves the process exit
 * code; never calls `process.exit` itself (that's `main()`'s job), so it's
 * safely unit-testable with fakes.
 */
export async function runTuiEntry(deps: TuiEntryDeps): Promise<number> {
  if (!deps.isTTY) {
    deps.errorOutput.write(`${TUI_NON_TTY_MESSAGE}\n`);
    return 1;
  }

  let record: NativeChatDiscoveryRecord | undefined;
  try {
    record = parseDiscoveryRecord(fs.readFileSync(deps.discoveryPath, 'utf8'));
  } catch {
    record = undefined;
  }
  if (!record) {
    deps.errorOutput.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
    return 1;
  }

  const transport = createHttpChatTransport(record);
  deps.onTransportReady?.(transport);
  // Wire deps.errorOutput through to launchTuiApp's own pre-render liveness
  // check so its failure message lands on the SAME stream every other
  // failure path in this function writes to, not a hardcoded
  // `process.stderr` the caller (a test, or a future non-stdio host) can't
  // observe.
  const launch =
    deps.launchApp ??
    ((transport_, cwd) =>
      launchTuiApp(transport_, cwd, { errorOutput: deps.errorOutput }));
  try {
    return await launch(transport, deps.cwd);
  } catch (err) {
    deps.errorOutput.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    await transport.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  let sigintTransport: ChatTransport | undefined;
  const sigint = (): void => {
    // Ink (raw mode) does not translate SIGINT for us either; exit cleanly
    // with a best-effort close, leaving the stored session intact — same
    // contract as deus-native-chat-client.ts's own sigint handler.
    void (sigintTransport?.close().catch(() => {}) ?? Promise.resolve()).then(
      () => process.exit(0),
    );
  };
  process.once('SIGINT', sigint);

  const code = await runTuiEntry({
    isTTY: Boolean(process.stdout.isTTY),
    errorOutput: process.stderr,
    discoveryPath: nativeChatDiscoveryPath(),
    cwd: process.cwd(),
    onTransportReady: (transport) => {
      sigintTransport = transport;
    },
  });
  process.exit(code);
}

const isDirectRun =
  process.argv[1]?.endsWith('deus-tui-entry.js') ||
  process.argv[1]?.endsWith('deus-tui-entry.ts');
if (isDirectRun) {
  void main();
}
