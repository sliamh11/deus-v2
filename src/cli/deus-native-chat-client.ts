/**
 * `deus chat` terminal client (LIA-428 / G1, LIA-430 / G3) — the compiled executable the
 * shell/PowerShell launchers invoke (`dist/cli/deus-native-chat-client.js`).
 *
 * Thin client: it reads the daemon's discovery record, sends authenticated
 * loopback requests, and renders ONLY normalized display events and terminal
 * prompts. It never instantiates a runtime, never reads provider
 * credentials, and never prints request/response objects, bearer tokens,
 * runtime event discriminants, session refs, or NDJSON framing.
 *
 * Non-goals (see deus-native-chat.ts's module doc): no G2 model-selection
 * flags and no session picker. Local commands are /plan on|off, /status,
 * /exit, and /quit.
 */

import fs from 'fs';
import readline from 'readline';

import { DENY_TIMEOUT_MS } from '../agent-runtimes/permission-registry.js';
import type { PermissionDecision } from '../agent-runtimes/types.js';
import {
  nativeChatDiscoveryPath,
  parseDiscoveryRecord,
  NATIVE_CHAT_PROTOCOL_VERSION,
  type ChatDisplayEvent,
  type NativeChatDiscoveryRecord,
  type NativeChatStatus,
} from './deus-native-chat.js';
import {
  formatNativeModelConfig,
  loadNativeModelConfig,
  setNativeModel,
} from './deus-native-model-config.js';

const MODEL_USAGE = [
  'Usage:',
  '  deus chat model set --provider <provider> --model <model>',
  '  deus chat model set --role <role> --provider <provider> --model <model>',
  '  deus chat model show',
  '  deus chat model show --role <role>',
].join('\n');

export interface ModelCommandDeps {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  configPath?: string;
}

function parseFlags(args: string[]): Record<string, string> | undefined {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      !flag?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    )
      return undefined;
    const name = flag.slice(2);
    if (flags[name] !== undefined) return undefined;
    flags[name] = value;
  }
  return flags;
}

export function runModelCommand(
  args: string[],
  deps: ModelCommandDeps,
): number {
  const operation = args[0];
  const flags = parseFlags(args.slice(1));
  if (!flags || (operation !== 'set' && operation !== 'show')) {
    deps.errorOutput.write(`${MODEL_USAGE}\n`);
    return 2;
  }
  const allowed =
    operation === 'set'
      ? new Set(['provider', 'model', 'role'])
      : new Set(['role']);
  if (Object.keys(flags).some((flag) => !allowed.has(flag))) {
    deps.errorOutput.write(`${MODEL_USAGE}\n`);
    return 2;
  }
  if (operation === 'set' && (!flags.provider || !flags.model)) {
    deps.errorOutput.write(`${MODEL_USAGE}\n`);
    return 2;
  }
  try {
    if (operation === 'set') {
      setNativeModel(
        // Unvalidated CLI-flag cast: `flags.provider` is a plain string with
        // no structural check at this call site. Safe only because
        // `setNativeModel` immediately re-validates it via
        // `validateNativeModelRef` (model-selection.ts) before anything is
        // persisted — that downstream check, not this cast, is the actual
        // guard against an unknown provider.
        { provider: flags.provider as 'anthropic', model: flags.model },
        flags.role,
        deps.configPath,
      );
      const target = flags.role ? `role ${flags.role}` : 'main agent';
      deps.output.write(
        `Configured ${target}: ${flags.provider}/${flags.model}\n`,
      );
    } else {
      deps.output.write(
        `${formatNativeModelConfig(loadNativeModelConfig(deps.configPath), flags.role)}\n`,
      );
    }
    return 0;
  } catch (err) {
    deps.errorOutput.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

export const CHAT_UNAVAILABLE_MESSAGE =
  'Deus chat endpoint is unavailable: the Deus service is not running (or predates this CLI). ' +
  'Rebuild and restart it with `deus build`, then retry.';

/** Transport seam so the readline loop is testable without a live daemon. */
export interface ChatTransport {
  turn(
    prompt: string,
    cwd: string,
    onEvent: (event: ChatDisplayEvent) => void | Promise<void>,
  ): Promise<void>;
  respondPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  setPlanMode(enabled: boolean): Promise<NativeChatStatus>;
  status(): Promise<NativeChatStatus>;
  close(): Promise<void>;
}

const DISPLAY_KINDS = new Set([
  'assistant_text',
  'tool_use',
  'progress',
  'permission_request',
  'assistant_done',
  'chat_error',
]);

function isDisplayEvent(value: unknown): value is ChatDisplayEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    DISPLAY_KINDS.has((value as { kind: string }).kind)
  );
}

export function createHttpChatTransport(
  record: NativeChatDiscoveryRecord,
): ChatTransport {
  const base = `http://${record.host}:${record.port}`;
  const authHeaders = { authorization: `Bearer ${record.token}` };

  return {
    async respondPermission(
      requestId: string,
      decision: PermissionDecision,
    ): Promise<void> {
      const res = await fetch(`${base}/v1/native-chat/permission-response`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
      });
      if (!res.ok) {
        throw new Error(`permission response failed (${res.status})`);
      }
    },

    async setPlanMode(enabled: boolean): Promise<NativeChatStatus> {
      const res = await fetch(`${base}/v1/native-chat/plan`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: NATIVE_CHAT_PROTOCOL_VERSION,
          enabled,
        }),
      });
      if (!res.ok) throw new Error(`plan request failed (${res.status})`);
      return (await res.json()) as NativeChatStatus;
    },

    async status(): Promise<NativeChatStatus> {
      const res = await fetch(`${base}/v1/native-chat/status`, {
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`status request failed (${res.status})`);
      return (await res.json()) as NativeChatStatus;
    },

    async close(): Promise<void> {
      const res = await fetch(`${base}/v1/native-chat/close`, {
        method: 'POST',
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`close request failed (${res.status})`);
    },

    async turn(prompt, cwd, onEvent): Promise<void> {
      const res = await fetch(`${base}/v1/native-chat/turn`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: NATIVE_CHAT_PROTOCOL_VERSION,
          prompt,
          cwd,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat turn failed (${res.status})`);
      }
      // Parse the internal NDJSON stream; only validated display events
      // cross toward the renderer — framing never reaches the terminal.
      const decoder = new TextDecoder();
      let buffered = '';
      const consumeLine = async (line: string) => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return; // Corrupt frame: drop, never render raw.
        }
        if (isDisplayEvent(parsed)) await onEvent(parsed);
      };
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex);
          buffered = buffered.slice(newlineIndex + 1);
          await consumeLine(line);
          newlineIndex = buffered.indexOf('\n');
        }
      }
      await consumeLine(buffered);
    },
  };
}

export interface ChatCliDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  transport: ChatTransport;
  cwd: string;
}

function renderStatus(
  status: NativeChatStatus,
  output: NodeJS.WritableStream,
): void {
  output.write(`Backend: ${status.backend}\n`);
  renderMode(status, output);
  output.write(`Session: ${status.sessionId ?? 'not started'}\n`);
  output.write(`State:   ${status.state}\n`);
  output.write(`Output:  ${status.output}\n`);
}

function renderMode(
  status: NativeChatStatus,
  output: NodeJS.WritableStream,
): void {
  output.write(`Mode:    ${status.mode} (${status.permissionProfile})\n`);
}

/**
 * Interactive loop. Resolves with the process exit code once the user exits
 * (/exit, /quit, EOF/Ctrl-D, or SIGINT) or startup fails.
 */
export async function runChatCli(deps: ChatCliDeps): Promise<number> {
  const { input, output, errorOutput, transport, cwd } = deps;

  let startupStatus: NativeChatStatus;
  try {
    startupStatus = await transport.status();
  } catch {
    errorOutput.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
    return 1;
  }

  output.write(
    'Deus chat — type a message. /plan on|off changes mode, /status shows diagnostics, /exit quits.\n',
  );
  renderMode(startupStatus, output);
  if (startupStatus.state === 'resumed') {
    output.write(
      'Resumed your previous conversation (run /status for details).\n',
    );
  }
  output.write('\n');

  const rl = readline.createInterface({ input, output, terminal: false });

  // Renderer state: whether assistant text is mid-line, so tool/progress
  // lines and turn completion insert clean separation.
  let lineOpen = false;
  let pendingPermissionResolve: ((raw: string) => void) | undefined;
  const render = async (event: ChatDisplayEvent): Promise<void> => {
    switch (event.kind) {
      case 'assistant_text':
        output.write(event.text);
        lineOpen = !event.text.endsWith('\n');
        break;
      case 'tool_use':
        if (lineOpen) {
          output.write('\n');
          lineOpen = false;
        }
        output.write(`  ${event.label}\n`);
        break;
      case 'progress':
        if (lineOpen) {
          output.write('\n');
          lineOpen = false;
        }
        output.write(`  ${event.text}\n`);
        break;
      case 'permission_request':
        if (lineOpen) {
          output.write('\n');
          lineOpen = false;
        }
        output.write(`Tool: ${event.toolName}\n`);
        output.write(`Input: ${event.toolInputPreview}\n`);
        output.write(`(auto-denies in ${DENY_TIMEOUT_MS / 1_000}s)\n`);
        await new Promise<void>((resolvePermissionPrompt) => {
          const showPermissionPrompt = (): void => {
            output.write('[y]es / [N]o ');
          };
          pendingPermissionResolve = (raw: string): void => {
            const answer = raw.trim().toLowerCase();
            let decision: PermissionDecision;
            if (answer === 'y' || answer === 'yes') {
              decision = 'allow_once';
            } else if (answer === '' || answer === 'n' || answer === 'no') {
              decision = 'deny';
            } else {
              showPermissionPrompt();
              return;
            }

            pendingPermissionResolve = undefined;
            output.write('\n');
            void transport
              .respondPermission(event.requestId, decision)
              .catch(() => {
                errorOutput.write(
                  `Error: failed to send the permission response; this request will auto-deny in ${DENY_TIMEOUT_MS / 1_000}s.\n`,
                );
              })
              .then(resolvePermissionPrompt);
          };
          showPermissionPrompt();
        });
        break;
      case 'assistant_done':
        if (lineOpen) output.write('\n');
        output.write('\n');
        lineOpen = false;
        break;
      case 'chat_error':
        if (lineOpen) {
          output.write('\n');
          lineOpen = false;
        }
        errorOutput.write(`Error: ${event.message}\n`);
        break;
      default: {
        const unhandled: never = event;
        void unhandled;
        break;
      }
    }
  };

  return await new Promise<number>((resolve) => {
    let finished = false;
    const queue: string[] = [];
    let processing = false;

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      rl.close();
      // Best-effort authenticated close; the stored session must survive
      // regardless (the close route never clears it).
      void transport
        .close()
        .catch(() => {})
        .then(() => resolve(code));
    };

    const prompt = (): void => {
      if (!finished) output.write('> ');
    };

    const handleLine = async (raw: string): Promise<void> => {
      const line = raw.trim();
      if (line === '') return;
      if (line === '/exit' || line === '/quit') {
        finish(0);
        return;
      }
      if (line === '/status') {
        try {
          renderStatus(await transport.status(), output);
        } catch {
          errorOutput.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
        }
        return;
      }
      if (line === '/plan on' || line === '/plan off') {
        try {
          const status = await transport.setPlanMode(line === '/plan on');
          renderMode(status, output);
        } catch {
          errorOutput.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
        }
        return;
      }
      if (/^\/plan(?:\s|$)/.test(line)) {
        output.write('Usage: /plan on|off\n');
        return;
      }
      try {
        await transport.turn(line, cwd, render);
      } catch {
        if (lineOpen) {
          output.write('\n');
          lineOpen = false;
        }
        errorOutput.write(
          'Error: the chat request failed. Is the Deus service still running?\n',
        );
      }
    };

    // Sequential pump: lines received while a turn is in flight are queued,
    // never sent as overlapping requests.
    let eofSeen = false;
    const pump = async (): Promise<void> => {
      if (processing) return;
      processing = true;
      while (queue.length > 0 && !finished) {
        const line = queue.shift() as string;
        await handleLine(line);
      }
      processing = false;
      if (eofSeen && queue.length === 0) {
        finish(0);
        return;
      }
      prompt();
    };

    rl.on('line', (line) => {
      if (pendingPermissionResolve) {
        pendingPermissionResolve(line);
        return;
      }
      queue.push(line);
      void pump();
    });
    // EOF (Ctrl-D) or input stream end: drain any queued lines, then exit
    // cleanly. (finish() itself calls rl.close(); the finished flag makes
    // the resulting re-entrant 'close' a no-op.)
    rl.on('close', () => {
      eofSeen = true;
      if (!processing && queue.length === 0) finish(0);
    });
    rl.on('SIGINT', () => finish(0));

    prompt();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'model') {
    process.exit(
      runModelCommand(args.slice(1), {
        output: process.stdout,
        errorOutput: process.stderr,
      }),
    );
  }
  if (args.length > 0) {
    // Only `model` is a recognized subcommand (handled above); plan mode is
    // an authenticated in-chat command (`/plan on|off`), not a process flag.
    process.stderr.write(
      `deus chat takes no arguments other than the 'model' subcommand.\n${MODEL_USAGE}\n`,
    );
    process.exit(2);
  }

  let record: NativeChatDiscoveryRecord | undefined;
  try {
    record = parseDiscoveryRecord(
      fs.readFileSync(nativeChatDiscoveryPath(), 'utf8'),
    );
  } catch {
    record = undefined;
  }
  if (!record) {
    process.stderr.write(`${CHAT_UNAVAILABLE_MESSAGE}\n`);
    process.exit(1);
  }

  const transport = createHttpChatTransport(record);
  const sigint = () => {
    // readline (terminal:false) does not translate SIGINT for us; exit
    // cleanly with a best-effort close, leaving the stored session intact.
    void transport
      .close()
      .catch(() => {})
      .then(() => process.exit(0));
  };
  process.once('SIGINT', sigint);

  const code = await runChatCli({
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    transport,
    cwd: process.cwd(),
  });
  process.exit(code);
}

const isDirectRun =
  process.argv[1]?.endsWith('deus-native-chat-client.js') ||
  process.argv[1]?.endsWith('deus-native-chat-client.ts');
if (isDirectRun) {
  void main();
}
