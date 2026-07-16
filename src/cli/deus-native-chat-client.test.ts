/**
 * Client-loop tests for LIA-428 / G1 and LIA-430 / G3 — scripted input/output against a fake
 * transport: two sequential prompts, /status, /exit, EOF cleanup, and the
 * framing-free rendering guarantee (acceptance criterion 3).
 */

import { PassThrough } from 'stream';

import { describe, it, expect } from 'vitest';

import type { ChatDisplayEvent, NativeChatStatus } from './deus-native-chat.js';
import {
  runChatCli,
  runModelCommand,
  CHAT_UNAVAILABLE_MESSAGE,
  type ChatTransport,
} from './deus-native-chat-client.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
  /** Display events emitted per turn (recycled if more turns arrive). */
  turnEvents?: ChatDisplayEvent[][];
  failStatus?: boolean;
  failTurn?: boolean;
}

function fakeTransport(options: FakeTransportOptions = {}) {
  const turns: string[] = [];
  const planTransitions: boolean[] = [];
  const baseline = options.status?.permissionProfile ?? 'default';
  let currentStatus = options.status ?? makeStatus();
  let closes = 0;
  let inFlight = 0;
  let sawOverlap = false;
  const transport: ChatTransport = {
    async status() {
      if (options.failStatus) throw new Error('unavailable');
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
      if (inFlight > 0) sawOverlap = true;
      inFlight += 1;
      try {
        if (options.failTurn) throw new Error('boom');
        turns.push(prompt);
        const script =
          options.turnEvents?.[
            Math.min(turns.length - 1, (options.turnEvents?.length ?? 1) - 1)
          ] ?? defaultTurnEvents(prompt);
        // Yield between events like a real streamed response would.
        for (const event of script) {
          await Promise.resolve();
          await onEvent(event);
        }
      } finally {
        inFlight -= 1;
      }
    },
    async close() {
      closes += 1;
    },
  };
  return {
    transport,
    turns,
    planTransitions,
    get closes() {
      return closes;
    },
    get sawOverlap() {
      return sawOverlap;
    },
  };
}

function defaultTurnEvents(prompt: string): ChatDisplayEvent[] {
  return [
    { kind: 'assistant_text', text: `echo:${prompt}` },
    { kind: 'assistant_done' },
  ];
}

async function runScripted(
  lines: string[],
  options: FakeTransportOptions = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let stdout = '';
  let stderr = '';
  output.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  errorOutput.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const fake = fakeTransport(options);
  const done = runChatCli({
    input,
    output,
    errorOutput,
    transport: fake.transport,
    cwd: '/client/cwd',
  });

  for (const line of lines) {
    input.write(`${line}\n`);
  }
  input.end(); // EOF after the scripted lines.

  const code = await done;
  return {
    code,
    fake,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe('runChatCli', () => {
  it('handles two consecutive prompts sequentially in one session, then /exit', async () => {
    const run = await runScripted([
      'first question',
      'second question',
      '/exit',
    ]);
    expect(run.code).toBe(0);
    expect(run.fake.turns).toEqual(['first question', 'second question']);
    expect(run.fake.sawOverlap).toBe(false);
    expect(run.stdout).toContain('echo:first question');
    expect(run.stdout).toContain('echo:second question');
    // Clean exit closes the transport exactly once.
    expect(run.fake.closes).toBe(1);
  });

  it('renders /status with mode plus the existing diagnostics', async () => {
    const run = await runScripted(['/status', '/quit']);
    expect(run.stdout).toContain('Backend: deus-native');
    expect(run.stdout).toContain('Mode:    normal (default)');
    expect(run.stdout).toContain(`Session: ${SESSION_ID}`);
    expect(run.stdout).toContain('State:   resumed');
    expect(run.stdout).toContain('Output:  buffered');
  });

  it('handles plan transitions locally, renders each mode, and never forwards commands as prompts', async () => {
    const run = await runScripted([
      '/plan on',
      '/status',
      'inspect this',
      '/plan off',
      '/exit',
    ]);

    expect(run.fake.planTransitions).toEqual([true, false]);
    expect(run.fake.turns).toEqual(['inspect this']);
    expect(run.stdout).toContain('Mode:    plan (read-only)');
    expect(run.stdout).toContain('Mode:    normal (default)');
  });

  it('prints plan usage for invalid forms and keeps the loop usable', async () => {
    const run = await runScripted([
      '/plan',
      '/plan maybe',
      '/plan on now',
      'still works',
      '/exit',
    ]);
    expect(run.stdout.match(/Usage: \/plan on\|off/g)).toHaveLength(3);
    expect(run.fake.planTransitions).toEqual([]);
    expect(run.fake.turns).toEqual(['still works']);
  });

  it('shows "not started" before the first successful turn', async () => {
    const run = await runScripted(['/status', '/exit'], {
      status: makeStatus({ sessionId: undefined, state: 'new' }),
    });
    expect(run.stdout).toContain('Session: not started');
    expect(run.stdout).toContain('State:   new');
    // No resume notice on a brand-new session.
    expect(run.stdout).not.toContain('Resumed your previous conversation');
  });

  it('announces a resumed session at startup and directs to /status', async () => {
    const run = await runScripted(['/exit']);
    expect(run.stdout).toContain('Resumed your previous conversation');
    expect(run.stdout).toContain('/status');
  });

  it('shows the current plan mode in the startup banner', async () => {
    const run = await runScripted(['/exit'], {
      status: makeStatus({
        mode: 'plan',
        permissionProfile: 'read-only',
      }),
    });
    expect(run.stdout).toContain('Mode:    plan (read-only)');
  });

  it('exits cleanly on EOF (no /exit) with a best-effort close', async () => {
    const run = await runScripted(['just one prompt']);
    expect(run.code).toBe(0);
    expect(run.fake.closes).toBe(1);
    expect(run.fake.turns).toEqual(['just one prompt']);
  });

  it('renders tool feedback and progress lines without protocol framing (AC3)', async () => {
    const run = await runScripted(['search something', '/exit'], {
      turnEvents: [
        [
          { kind: 'tool_use', label: 'Using web_search: something…' },
          { kind: 'progress', text: 'thinking about it' },
          { kind: 'assistant_text', text: 'Here is what I found.' },
          { kind: 'assistant_done' },
        ],
      ],
    });
    expect(run.stdout).toContain('Using web_search: something…');
    expect(run.stdout).toContain('thinking about it');
    expect(run.stdout).toContain('Here is what I found.');

    // AC3 pinned mechanically: no event/transport JSON, discriminants, or
    // NDJSON/SSE delimiters in ANY terminal output.
    for (const streamText of [run.stdout, run.stderr]) {
      expect(streamText).not.toContain('{"type":');
      expect(streamText).not.toContain('{"kind":');
      expect(streamText).not.toContain('output_text');
      expect(streamText).not.toContain('turn_complete');
      expect(streamText).not.toContain('sessionRef');
      expect(streamText).not.toContain('assistant_done');
      expect(streamText).not.toContain('data:');
      expect(streamText).not.toContain('"done"');
    }
  });

  it('routes chat_error events to stderr as a single sanitized line', async () => {
    const run = await runScripted(['break please', '/exit'], {
      turnEvents: [[{ kind: 'chat_error', message: 'the provider failed' }]],
    });
    expect(run.stderr).toContain('Error: the provider failed');
    expect(run.stderr).not.toContain('{');
  });

  it('fails closed with the actionable unavailable message when the daemon is unreachable', async () => {
    const run = await runScripted([], { failStatus: true });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(CHAT_UNAVAILABLE_MESSAGE);
  });

  it('keeps the loop alive when a single turn request fails mid-session', async () => {
    const run = await runScripted(['this will fail', '/status', '/exit'], {
      failTurn: true,
    });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Error: the chat request failed');
    // The loop continued to /status after the failure.
    expect(run.stdout).toContain('Backend: deus-native');
  });

  it('ignores empty input lines instead of sending empty prompts', async () => {
    const run = await runScripted(['', '   ', 'real prompt', '/exit']);
    expect(run.fake.turns).toEqual(['real prompt']);
  });
});

describe('runModelCommand', () => {
  it('sets and shows models locally with validation exit codes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-model-command-'));
    const configPath = path.join(dir, 'native-models.json');
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = '';
    let stderr = '';
    output.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    errorOutput.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const deps = { output, errorOutput, configPath };
    expect(
      runModelCommand(
        ['set', '--provider', 'anthropic', '--model', 'claude-sonnet-4-6'],
        deps,
      ),
    ).toBe(0);
    expect(
      runModelCommand(
        [
          'set',
          '--role',
          'researcher',
          '--provider',
          'anthropic',
          '--model',
          'claude-haiku-4-5-20251001',
        ],
        deps,
      ),
    ).toBe(0);
    expect(runModelCommand(['show', '--role', 'writer'], deps)).toBe(0);
    expect(stdout).toContain('inherits main');
    expect(
      runModelCommand(['set', '--provider', 'openai', '--model', 'x'], deps),
    ).toBe(1);
    expect(stderr).toContain('Supported providers: anthropic');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns usage exit 2 for duplicate, missing, and inappropriate flags', () => {
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const deps = { output, errorOutput };
    expect(runModelCommand(['set', '--provider', 'anthropic'], deps)).toBe(2);
    expect(runModelCommand(['show', '--model', 'x'], deps)).toBe(2);
    expect(runModelCommand(['show', '--role', 'a', '--role', 'b'], deps)).toBe(
      2,
    );
  });
});
