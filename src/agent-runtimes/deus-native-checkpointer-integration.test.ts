/**
 * B4 (LIA-404): end-to-end integration tests for deus-native's
 * checkpointer-backed session persistence, against a REAL SqliteSaver on a
 * per-test temp file and the REAL LangGraph graph-execution engine (real
 * createAgent, scripted FakeToolCallingModel — B2/B3's own precedent). A
 * mocked createAgent would make the checkpointer state meaningless.
 *
 * Isolation approach: this file tests deus-native-backend.ts (a DIFFERENT
 * module from checkpointer.ts), so it legitimately mocks './checkpointer.js'
 * CROSS-module — the same class of mock lifecycle-events.test.ts already
 * uses for group-folder.js, NOT the same-module self-mock that plan review
 * correctly rejected for checkpointer.test.ts itself. The mocked
 * getCheckpointer routes EVERY call (regardless of arguments) through the
 * REAL, parameter-injectable getCheckpointer at harness.checkpointerDbPath,
 * so runTurn's internal calls and this file's own direct getCheckpointer()
 * assertions all resolve to the same per-test temp database. The real
 * module's memoization is still active underneath the mock wrapper, hence
 * _resetCheckpointerForTests() in beforeEach.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tool, FakeToolCallingModel } from 'langchain';

import { getCheckpointer } from './checkpointer.js';
import { defaultSession } from './types.js';
import type { RuntimeEvent, RunContext } from './types.js';
import type { ContainerRuntimeDeps } from './container-backend.js';

// ---------------------------------------------------------------------------
// Shared mutable harness (hoisted so the module mocks below can reach it) —
// lifecycle-events.test.ts's own established convention, extended with
// checkpointerDbPath for B4.
// ---------------------------------------------------------------------------
const harness = vi.hoisted(() => ({
  groupsDir: '',
  checkpointerDbPath: '',
  makeModel: null as null | (() => unknown),
  tools: [] as unknown[],
  captured: [] as Array<{ systemMessage: unknown; messages: unknown[] }>,
}));

// Real langchain everywhere — only createAgent is wrapped, to (a) swap the
// model for the test's scripted FakeToolCallingModel and (b) append a capture
// middleware LAST (innermost), recording the exact ModelRequest each model
// call receives (both the injected systemMessage and the full messages
// array the checkpointer-loaded state produced).
vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>();
  const capture = actual.createMiddleware({
    name: 'b4-test-capture',
    wrapModelCall: (request, handler) => {
      harness.captured.push({
        systemMessage: request.systemMessage,
        messages: [...request.messages],
      });
      return handler(request);
    },
  });
  return {
    ...actual,
    createAgent: (config: Parameters<typeof actual.createAgent>[0]) =>
      actual.createAgent({
        ...config,
        model: harness.makeModel
          ? (harness.makeModel() as typeof config.model)
          : config.model,
        middleware: [
          ...(config.middleware ?? []),
          capture,
        ] as typeof config.middleware,
      }),
  };
});

// The B4 cross-module checkpointer mock: route every getCheckpointer call
// through the REAL implementation pinned at the per-test temp file.
vi.mock('./checkpointer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./checkpointer.js')>();
  return {
    ...actual,
    getCheckpointer: () => actual.getCheckpointer(harness.checkpointerDbPath),
  };
});

// Redirect group-folder resolution into the per-test temp fixture dir
// (loadSessionOpenContext derives groups/global as the group dir's sibling).
vi.mock('../group-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../group-folder.js')>();
  const nodePath = await import('path');
  return {
    ...actual,
    resolveGroupFolderPath: (folder: string) =>
      nodePath.join(harness.groupsDir, folder),
  };
});

// Hermeticity mocks, mirroring lifecycle-events.test.ts's convention.
vi.mock('../credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key' as const,
}));
vi.mock('../group-tokens.js', () => ({
  getOrCreateGroupToken: () => 'fake-proxy-token',
}));
vi.mock('./tool-broker-langchain-adapter.js', () => ({
  buildSafeTools: async () => harness.tools,
}));

const { createDeusNativeRuntime } = await import('./deus-native-backend.js');
const { _resetCheckpointerForTests } = await import('./checkpointer.js');

const stubDeps: ContainerRuntimeDeps = {
  resolveGroup: () => undefined,
  assistantName: 'Deus',
  registerProcess: () => {},
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runCtx(groupFolder: string, prompt = 'hello there'): RunContext {
  return {
    prompt,
    groupFolder,
    chatJid: 'test@g.us',
    isControlGroup: false,
  };
}

function writeGroupClaudeMd(folder: string, content: string): void {
  const dir = path.join(harness.groupsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
}

/** Text content of a captured SystemMessage (or '' for non-string shapes). */
function msgText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content : '';
}

/** All string contents from one captured ModelRequest's messages array. */
function messageTexts(messages: unknown[]): string[] {
  return messages
    .map((m) => (m as { content?: unknown }).content)
    .filter((c): c is string => typeof c === 'string');
}

const ECHO_TOOL = tool(
  async (args: { value: string }) => `echo:${args.value}`,
  {
    name: 'echo_tool',
    description: 'Echoes the provided value back.',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
);

function singleCycleModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({ toolCalls: [[]] });
}

function toolCallThenAnswerModel(): FakeToolCallingModel {
  return new FakeToolCallingModel({
    toolCalls: [
      [{ name: 'echo_tool', args: { value: 'ping' }, id: 'call_1' }],
      [],
    ],
  });
}

let checkpointerTempDir = '';

beforeEach(() => {
  harness.groupsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'b4-integration-groups-'),
  );
  checkpointerTempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'b4-integration-checkpointer-'),
  );
  harness.checkpointerDbPath = path.join(checkpointerTempDir, 'checkpoints.db');
  // The REAL module's memoization is still active underneath the mock
  // wrapper — without this reset, this test would silently reuse the
  // PREVIOUS test's (deleted) database file.
  _resetCheckpointerForTests();
  harness.makeModel = singleCycleModel;
  harness.tools = [];
  harness.captured.length = 0;
});

afterEach(() => {
  _resetCheckpointerForTests();
  fs.rmSync(harness.groupsDir, { recursive: true, force: true });
  fs.rmSync(checkpointerTempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — a deus-native session row references real checkpointer state.
// ---------------------------------------------------------------------------
describe('new session (AC1: session row references checkpointer state)', () => {
  it('mints a fresh UUID and a checkpoint genuinely exists for that thread_id afterward', async () => {
    const runtime = createDeusNativeRuntime(stubDeps);

    const result = await runtime.runTurn(
      runCtx('newgroup', 'first ever message'),
      defaultSession('', 'deus-native'),
      () => {},
    );
    expect(result.status).toBe('success');
    const sessionId = result.sessionRef?.session_id;
    expect(sessionId).toMatch(UUID_PATTERN);
    expect(result.sessionRef?.backend).toBe('deus-native');

    // This getCheckpointer() call is this file's OWN import from
    // './checkpointer.js' — the SAME module path the vi.mock above
    // intercepts — so it resolves through the SAME mocked implementation
    // runTurn used (routed to harness.checkpointerDbPath regardless of
    // arguments), never the real, unmocked module.
    const tuple = await getCheckpointer().getTuple({
      configurable: { thread_id: sessionId as string },
    });
    // A checkpoint genuinely got WRITTEN (not just "the call succeeded"),
    // and it carries this turn's exchange.
    expect(tuple).toBeDefined();
    const channelMessages = (
      tuple?.checkpoint.channel_values as { messages?: unknown[] }
    ).messages;
    expect(Array.isArray(channelMessages)).toBe(true);
    const texts = messageTexts(channelMessages as unknown[]);
    expect(texts.some((t) => t.includes('first ever message'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — same-backend resume with REAL message continuity.
// ---------------------------------------------------------------------------
describe('same-backend resume (AC2: real conversation continuity)', () => {
  it('call 2 on the same session sees BOTH turns’ user messages in real accumulated state', async () => {
    const runtime = createDeusNativeRuntime(stubDeps);

    const result1 = await runtime.runTurn(
      runCtx('resumegroup', 'remember the word: pomegranate'),
      defaultSession('', 'deus-native'),
      () => {},
    );
    expect(result1.status).toBe('success');
    const sessionId = result1.sessionRef?.session_id as string;
    expect(sessionId).toMatch(UUID_PATTERN);

    harness.captured.length = 0;
    const result2 = await runtime.runTurn(
      runCtx('resumegroup', 'what did I ask you to remember?'),
      { backend: 'deus-native', session_id: sessionId },
      () => {},
    );
    expect(result2.status).toBe('success');
    expect(result2.sessionRef?.session_id).toBe(sessionId);

    // The exact messages array the model boundary saw on call 2 — must
    // contain BOTH call 1's and call 2's user messages, proving real
    // checkpointer-loaded accumulated state, not just "the call didn't
    // error".
    expect(harness.captured.length).toBeGreaterThan(0);
    const call2Texts = messageTexts(
      harness.captured[harness.captured.length - 1].messages,
    );
    expect(
      call2Texts.some((t) => t.includes('remember the word: pomegranate')),
    ).toBe(true);
    expect(
      call2Texts.some((t) => t.includes('what did I ask you to remember?')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Within-turn tool-call scoping regression (plan history item 1): a resumed
// turn must NOT re-emit tool_call events from earlier turns. This test
// directly falsifies the regression if the priorMessageCount slice is
// missing or wrong.
// ---------------------------------------------------------------------------
describe('tool-call event scoping on resume', () => {
  it('does not re-emit call 1’s tool call on the resumed call 2', async () => {
    const runtime = createDeusNativeRuntime(stubDeps);
    harness.tools = [ECHO_TOOL];
    harness.makeModel = toolCallThenAnswerModel;

    const events1: RuntimeEvent[] = [];
    const result1 = await runtime.runTurn(
      runCtx('toolgroup', 'call the echo tool'),
      defaultSession('', 'deus-native'),
      (event) => {
        events1.push(event);
      },
    );
    expect(result1.status).toBe('success');
    // Call 1's own tool call fired as expected.
    const toolEvents1 = events1.filter((e) => e.type === 'tool_call');
    expect(toolEvents1).toHaveLength(1);
    expect(toolEvents1[0]).toMatchObject({
      type: 'tool_call',
      name: 'echo_tool',
      arguments: { value: 'ping' },
    });

    // Call 2: same resumed thread, NO tool call this turn. The prior turn's
    // AIMessage (with its tool_calls) is still in the checkpointer-loaded
    // state — without the slice, the emission loop would re-emit it.
    harness.makeModel = singleCycleModel;
    const events2: RuntimeEvent[] = [];
    const result2 = await runtime.runTurn(
      runCtx('toolgroup', 'just answer plainly'),
      {
        backend: 'deus-native',
        session_id: result1.sessionRef?.session_id as string,
      },
      (event) => {
        events2.push(event);
      },
    );
    expect(result2.status).toBe('success');
    expect(events2.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    // The turn still completed normally.
    expect(events2.some((e) => e.type === 'turn_complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B3-upgrade-path regression (plan history item 3): a NON-EMPTY, pre-existing
// session_id (a B3-era row that predates any checkpointer) with NO real
// checkpoint must still be treated as a NEW session for injection purposes,
// while the echo-vs-mint decision stays unaffected. This test directly
// falsifies the fix if isNewSession ever regresses to a string check.
// ---------------------------------------------------------------------------
describe('B3-upgrade-path regression (isNewSession = real checkpoint existence)', () => {
  it('injects CLAUDE.md for a non-empty pre-B4 session_id with no checkpoint, and echoes the SAME id back', async () => {
    const runtime = createDeusNativeRuntime(stubDeps);
    writeGroupClaudeMd('upgradegroup', 'Upgrade-path rule content.');

    // Simulates a B3-era row: UUID-shaped, non-empty, never a real
    // checkpointer thread (nothing has ever been written for it in this
    // fresh per-test database).
    const preexistingId = crypto.randomUUID();
    const result = await runtime.runTurn(
      runCtx('upgradegroup'),
      { backend: 'deus-native', session_id: preexistingId },
      () => {},
    );
    expect(result.status).toBe('success');

    // Session-open CLAUDE.md content STILL injects — isNewSession is driven
    // by real checkpoint existence, not the non-empty string.
    expect(harness.captured.length).toBeGreaterThan(0);
    for (const call of harness.captured) {
      expect(msgText(call.systemMessage)).toContain(
        'Upgrade-path rule content.',
      );
    }

    // The echo-vs-mint decision is unaffected by the fix: the DB row's
    // identity is preserved even though injection correctly re-fires.
    expect(result.sessionRef?.session_id).toBe(preexistingId);
  });
});

// ---------------------------------------------------------------------------
// AC3 — backend mismatch: switching backends creates a new row instead of
// rewriting the prior row. Verified here (not just asserted): db.setSession's
// dedup WHERE clause is backend-scoped (db.ts:806). db.test.ts already
// covers claude/openai backend isolation at the pure-db level ('keeps
// separate sessions for each backend in the same group', 'replaces the
// active session for one backend without touching the other') — this test
// adds the deus-native-specific case with a REAL runTurn-minted session id,
// referencing (not duplicating) that existing coverage.
// ---------------------------------------------------------------------------
describe('backend mismatch (AC3: switching backends never rewrites the deus-native row)', () => {
  it('a claude session save leaves the runTurn-minted deus-native row intact, both rows coexisting', async () => {
    const { _initTestDatabase, setSession, getSession } =
      await import('../db.js');
    _initTestDatabase();

    const runtime = createDeusNativeRuntime(stubDeps);
    const result1 = await runtime.runTurn(
      runCtx('mismatchgroup'),
      defaultSession('', 'deus-native'),
      () => {},
    );
    expect(result1.status).toBe('success');
    const deusNativeId = result1.sessionRef?.session_id as string;
    expect(deusNativeId).toMatch(UUID_PATTERN);

    // Persist the deus-native session the way the orchestrator would.
    setSession('mismatchgroup', result1.sessionRef!);

    // Simulate the group switching backends.
    setSession('mismatchgroup', {
      backend: 'claude',
      session_id: 'some-claude-id',
    });

    // (a) deus-native's ORIGINAL session survives, unmodified/un-orphaned.
    expect(getSession('mismatchgroup', 'deus-native')?.session_id).toBe(
      deusNativeId,
    );
    // (b) the claude row coexists — neither rewrote the other.
    expect(getSession('mismatchgroup', 'claude')?.session_id).toBe(
      'some-claude-id',
    );
  });
});

// ---------------------------------------------------------------------------
// B5 (LIA-405) AC4 — session-row idempotency across a same-thread re-invoke:
// the ONE real idempotency property in today's deus-native path worth a
// frozen regression test (docs/decisions/deus-v2-replay-safety.md, Section 3).
// Invoking the SAME thread_id twice in a row with an already-existing
// session must leave exactly ONE row in `sessions` for (groupFolder,
// backend): setSession's dedup (db.ts:791-830) touches last_used_at instead
// of orphaning + inserting. Asserts the row's `id` (autoincrement primary
// key — `sessions` has no `created_at` column per db.ts:83-93) is unchanged
// and `last_used_at` advances, via the `_`-prefixed raw-row test accessor.
// ---------------------------------------------------------------------------
describe('same-thread re-invoke (B5 AC4: exactly one session row, id stable, last_used_at advances)', () => {
  it('a second runTurn + save on the same thread_id keeps a single un-orphaned row with the same id and a later last_used_at', async () => {
    const { _initTestDatabase, setSession, _getRawSessionRowsForTests } =
      await import('../db.js');
    _initTestDatabase();

    const runtime = createDeusNativeRuntime(stubDeps);

    // Turn 1: mint the session and persist it the way the orchestrator would.
    const result1 = await runtime.runTurn(
      runCtx('idempotentgroup', 'first turn'),
      defaultSession('', 'deus-native'),
      () => {},
    );
    expect(result1.status).toBe('success');
    const sessionId = result1.sessionRef?.session_id as string;
    expect(sessionId).toMatch(UUID_PATTERN);
    setSession('idempotentgroup', result1.sessionRef!);

    const rowsAfterFirst = _getRawSessionRowsForTests(
      'idempotentgroup',
      'deus-native',
    );
    expect(rowsAfterFirst).toHaveLength(1);
    const firstRow = rowsAfterFirst[0];
    expect(firstRow.orphaned_at).toBeNull();
    expect(firstRow.last_used_at).not.toBeNull();

    // setSession stamps last_used_at with millisecond-resolution ISO
    // timestamps — without this gap, both saves could land on the SAME
    // millisecond and "advances" would be unfalsifiable.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Turn 2: same thread_id (already-existing session), then re-save.
    const result2 = await runtime.runTurn(
      runCtx('idempotentgroup', 'second turn'),
      { backend: 'deus-native', session_id: sessionId },
      () => {},
    );
    expect(result2.status).toBe('success');
    expect(result2.sessionRef?.session_id).toBe(sessionId);
    setSession('idempotentgroup', result2.sessionRef!);

    const rowsAfterSecond = _getRawSessionRowsForTests(
      'idempotentgroup',
      'deus-native',
    );
    // Exactly ONE row — the dedup path updated in place; no orphan + insert.
    expect(rowsAfterSecond).toHaveLength(1);
    const secondRow = rowsAfterSecond[0];
    // The autoincrement primary key is unchanged: same physical row.
    expect(secondRow.id).toBe(firstRow.id);
    expect(secondRow.session_id).toBe(sessionId);
    expect(secondRow.orphaned_at).toBeNull();
    // last_used_at advanced (ISO-8601 strings compare lexicographically).
    expect(secondRow.last_used_at! > firstRow.last_used_at!).toBe(true);
  });
});
