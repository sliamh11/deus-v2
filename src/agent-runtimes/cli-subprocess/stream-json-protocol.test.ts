import { describe, expect, it } from 'vitest';

import {
  BoundedEventLog,
  StreamJsonLineParser,
  buildUserTurnInput,
  encodeNdjsonLine,
  extractAssistantText,
  extractToolResultBlocks,
  extractToolResultText,
  extractToolUseBlocks,
  isAssistantEvent,
  isResultEvent,
  isSystemInitEvent,
  isUserEvent,
  type AssistantEvent,
  type ResultEvent,
  type StreamJsonEvent,
  type SystemInitEvent,
  type UserEvent,
} from './stream-json-protocol.js';

// ── Input envelope ───────────────────────────────────────────────────────

describe('buildUserTurnInput / encodeNdjsonLine', () => {
  it('matches the SDKUserMessage envelope shape byte-for-byte', () => {
    const input = buildUserTurnInput('hello');
    expect(input).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: '',
    });
  });

  it('encodes as one newline-terminated JSON line', () => {
    const line = encodeNdjsonLine(buildUserTurnInput('hi'));
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2); // one JSON line + trailing empty
    expect(JSON.parse(line.trimEnd())).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
      session_id: '',
    });
  });
});

// ── Narrowing helpers (fixtures are the exact shapes verified live against
//    installed CLI 2.1.214) ──────────────────────────────────────────────

const SYSTEM_INIT_FIXTURE: StreamJsonEvent = {
  type: 'system',
  subtype: 'init',
  cwd: '/private/tmp/lia449-recon',
  session_id: 'f0cb01ad-781e-4d28-9cdf-ccf98c18a2b3',
  tools: ['mcp__deus_lia449__check_permission'],
  mcp_servers: [{ name: 'deus_lia449', status: 'connected' }],
  model: 'claude-opus-4-8[1m]',
  permissionMode: 'dontAsk',
};

const ASSISTANT_TEXT_FIXTURE: StreamJsonEvent = {
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    id: 'msg_011',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: null,
  },
  parent_tool_use_id: null,
  session_id: 'f0cb01ad-781e-4d28-9cdf-ccf98c18a2b3',
};

const ASSISTANT_TOOL_USE_FIXTURE: StreamJsonEvent = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '' },
      {
        type: 'tool_use',
        id: 'toolu_01SbHWJupz5KRA61z2Azde3a',
        name: 'mcp__deus_lia449__check_permission',
        input: { toolName: 'write_file', probeId: 'recon-probe-1' },
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: 'bdab0915-a604-476d-b38c-efe568ff4b89',
};

const USER_TOOL_RESULT_FIXTURE: StreamJsonEvent = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01SbHWJupz5KRA61z2Azde3a',
        type: 'tool_result',
        content: [
          {
            type: 'text',
            text: '{"probeId":"recon-probe-1","decision":"deny","source":"rule"}',
          },
        ],
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: 'bdab0915-a604-476d-b38c-efe568ff4b89',
};

// Real shape observed live for an MCP `isError: true` tool result (LIA-454
// §3.1 spike, `lia449b_mcp_deny_equivalence_spike.ts` — the CLI represents
// `content` as a plain string here, not an array of parts, unlike the
// normal-result fixture above).
const USER_TOOL_ERROR_RESULT_FIXTURE: StreamJsonEvent = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01TacHwD6YXs875tnkpKSCXw',
        type: 'tool_result',
        content:
          'permission_denied: tool "write_file" was blocked by the ' +
          '"read-only" permission profile (tool "write_file" is ' +
          'explicitly denied by rule 7 of this policy). The call was not ' +
          'executed; continue without this tool. (probeId: lia449b-deny)',
        is_error: true,
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: 'bdab0915-a604-476d-b38c-efe568ff4b89',
};

const RESULT_SUCCESS_FIXTURE: StreamJsonEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4498,
  result: 'ok',
  session_id: 'bdab0915-a604-476d-b38c-efe568ff4b89',
};

describe('narrowing helpers', () => {
  it('isSystemInitEvent narrows system/init and rejects other types', () => {
    expect(isSystemInitEvent(SYSTEM_INIT_FIXTURE)).toBe(true);
    expect(isSystemInitEvent(ASSISTANT_TEXT_FIXTURE)).toBe(false);
    expect(
      isSystemInitEvent({ type: 'system', subtype: 'thinking_tokens' }),
    ).toBe(false);
  });

  it('isAssistantEvent narrows assistant and rejects other types', () => {
    expect(isAssistantEvent(ASSISTANT_TEXT_FIXTURE)).toBe(true);
    expect(isAssistantEvent(ASSISTANT_TOOL_USE_FIXTURE)).toBe(true);
    expect(isAssistantEvent(USER_TOOL_RESULT_FIXTURE)).toBe(false);
    expect(isAssistantEvent({ type: 'assistant' })).toBe(false); // no message
  });

  it('isUserEvent narrows user and rejects other types', () => {
    expect(isUserEvent(USER_TOOL_RESULT_FIXTURE)).toBe(true);
    expect(isUserEvent(ASSISTANT_TEXT_FIXTURE)).toBe(false);
  });

  it('isResultEvent narrows result and rejects other types', () => {
    expect(isResultEvent(RESULT_SUCCESS_FIXTURE)).toBe(true);
    expect(isResultEvent(ASSISTANT_TEXT_FIXTURE)).toBe(false);
  });
});

describe('extraction helpers', () => {
  it('extractAssistantText joins text blocks', () => {
    expect(extractAssistantText(ASSISTANT_TEXT_FIXTURE as AssistantEvent)).toBe(
      'pong',
    );
  });

  it('extractToolUseBlocks finds the tool_use block among thinking/text', () => {
    const blocks = extractToolUseBlocks(
      ASSISTANT_TOOL_USE_FIXTURE as AssistantEvent,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      name: 'mcp__deus_lia449__check_permission',
      input: { toolName: 'write_file', probeId: 'recon-probe-1' },
    });
  });

  it('extractToolResultBlocks + extractToolResultText round-trip the tool payload', () => {
    const blocks = extractToolResultBlocks(
      USER_TOOL_RESULT_FIXTURE as UserEvent,
    );
    expect(blocks).toHaveLength(1);
    const text = extractToolResultText(blocks[0]);
    expect(JSON.parse(text)).toMatchObject({
      probeId: 'recon-probe-1',
      decision: 'deny',
      source: 'rule',
    });
  });

  it('extractToolResultText handles a plain-string content payload (isError:true shape)', () => {
    const blocks = extractToolResultBlocks(
      USER_TOOL_ERROR_RESULT_FIXTURE as UserEvent,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].is_error).toBe(true);
    const text = extractToolResultText(blocks[0]);
    expect(text).toContain(
      'permission_denied: tool "write_file" was blocked by the ' +
        '"read-only" permission profile',
    );
    expect(text).toContain(
      'The call was not executed; continue without this tool.',
    );
  });

  it('type guards accept the fixtures as their narrowed types for TS', () => {
    // Exercises the type-level contract, not just the boolean predicate.
    const init: SystemInitEvent | undefined = isSystemInitEvent(
      SYSTEM_INIT_FIXTURE,
    )
      ? SYSTEM_INIT_FIXTURE
      : undefined;
    expect(init?.mcp_servers[0]?.status).toBe('connected');

    const result: ResultEvent | undefined = isResultEvent(
      RESULT_SUCCESS_FIXTURE,
    )
      ? RESULT_SUCCESS_FIXTURE
      : undefined;
    expect(result?.result).toBe('ok');
  });
});

// ── NDJSON framing ───────────────────────────────────────────────────────

describe('StreamJsonLineParser', () => {
  it('parses a single complete line delivered in one chunk', () => {
    const parser = new StreamJsonLineParser();
    const results = parser.push('{"type":"result","subtype":"success"}\n');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'event',
      event: { type: 'result', subtype: 'success' },
    });
  });

  it('reassembles a line split across arbitrary chunk boundaries', () => {
    const parser = new StreamJsonLineParser();
    const full = '{"type":"assistant","message":{"content":[]}}\n';
    // Split at three different byte offsets, none aligned to any token.
    const chunks = [full.slice(0, 5), full.slice(5, 17), full.slice(17)];
    const results = chunks.flatMap((chunk) => parser.push(chunk));
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('event');
    expect(results[0].event).toEqual({
      type: 'assistant',
      message: { content: [] },
    });
  });

  it('handles multiple complete lines in a single chunk', () => {
    const parser = new StreamJsonLineParser();
    const chunk = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';
    const results = parser.push(chunk);
    expect(results.map((r) => r.event?.type)).toEqual(['a', 'b', 'c']);
  });

  it('surfaces a non-empty malformed line as a protocol failure, not silent noise', () => {
    const parser = new StreamJsonLineParser();
    const results = parser.push('not json at all\n');
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('malformed');
    expect(results[0].raw).toBe('not json at all');
    expect(results[0].error).toBeDefined();
  });

  it('silently skips blank lines (not "noise" — just line-ending artifacts)', () => {
    const parser = new StreamJsonLineParser();
    const results = parser.push('\n\n{"type":"x"}\n\n');
    expect(results).toHaveLength(1);
    expect(results[0].event).toEqual({ type: 'x' });
  });

  it('bounds the partial-line buffer and surfaces overflow instead of growing unboundedly', () => {
    const parser = new StreamJsonLineParser(50);
    const results = parser.push('a'.repeat(51)); // no newline yet, over cap
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('overflow');
    expect(parser.bufferedChars).toBe(0); // cleared, not retained
  });

  it('does not overflow when a long line is still under the cap and terminated', () => {
    const parser = new StreamJsonLineParser(1000);
    const results = parser.push(`{"type":"${'x'.repeat(100)}"}\n`);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('event');
  });

  it('flush() surfaces a non-empty trailing partial line exactly like push()', () => {
    const parser = new StreamJsonLineParser();
    parser.push('{"type":"partial"'); // no trailing newline — stream ended mid-line
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].kind).toBe('malformed'); // incomplete JSON
    expect(parser.bufferedChars).toBe(0);
  });

  it('flush() is a no-op when the buffer is already empty', () => {
    const parser = new StreamJsonLineParser();
    parser.push('{"type":"x"}\n');
    expect(parser.flush()).toEqual([]);
  });
});

// ── Bounded evidence retention ───────────────────────────────────────────

describe('BoundedEventLog', () => {
  it('retains insertion order up to the cap', () => {
    const log = new BoundedEventLog<number>(3);
    log.push(1);
    log.push(2);
    log.push(3);
    expect(log.toArray()).toEqual([1, 2, 3]);
    expect(log.length).toBe(3);
  });

  it('drops the oldest entry once the cap is exceeded, never growing unboundedly', () => {
    const log = new BoundedEventLog<number>(3);
    for (const n of [1, 2, 3, 4, 5]) log.push(n);
    expect(log.toArray()).toEqual([3, 4, 5]);
    expect(log.length).toBe(3);
  });

  it('throws on a non-positive cap rather than silently accepting an unbounded log', () => {
    expect(() => new BoundedEventLog<number>(0)).toThrow();
  });
});
