import { describe, expect, it } from 'vitest';

import {
  BoundedEventLog,
  StreamJsonLineParser,
  buildUserTurnInput,
  encodeNdjsonLine,
  extractAssistantMessageId,
  extractAssistantModel,
  extractAssistantText,
  extractAssistantUsage,
  extractToolResultBlocks,
  extractToolResultText,
  extractToolUseBlocks,
  isAssistantEvent,
  isResultEvent,
  isSystemInitEvent,
  isUserEvent,
  normalizeCliUsageToLangChainUsage,
  validateTurnEventSequence,
  type AssistantEvent,
  type CliUsage,
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

// ── Real usage/model-ID fields (EP-002 step 2.3 spike, `claude 2.1.215`,
//    `--output-format stream-json --verbose`) ────────────────────────────

const ASSISTANT_WITH_USAGE_FIXTURE: StreamJsonEvent = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CdBQeR2o2KQyqYuLKbPbv',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ready' }],
    stop_reason: null,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 29792,
      cache_read_input_tokens: 23538,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 29792,
      },
      output_tokens: 4,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
  },
  parent_tool_use_id: null,
  session_id: '05e7b36d-7df0-4475-8764-a141ff820bd1',
};

describe('assistant usage/model-ID extraction (real captured shape)', () => {
  it('extractAssistantMessageId returns the real message id', () => {
    expect(
      extractAssistantMessageId(ASSISTANT_WITH_USAGE_FIXTURE as AssistantEvent),
    ).toBe('msg_011CdBQeR2o2KQyqYuLKbPbv');
  });

  it('extractAssistantModel returns the exact resolved model id string', () => {
    expect(
      extractAssistantModel(ASSISTANT_WITH_USAGE_FIXTURE as AssistantEvent),
    ).toBe('claude-sonnet-5');
  });

  it('extractAssistantMessageId/Model return undefined when absent, never fabricated', () => {
    expect(
      extractAssistantMessageId(ASSISTANT_TOOL_USE_FIXTURE as AssistantEvent),
    ).toBeUndefined();
    expect(
      extractAssistantModel(ASSISTANT_TOOL_USE_FIXTURE as AssistantEvent),
    ).toBeUndefined();
  });

  it('extractAssistantUsage returns the real per-cycle usage object', () => {
    const usage = extractAssistantUsage(
      ASSISTANT_WITH_USAGE_FIXTURE as AssistantEvent,
    );
    expect(usage).toEqual({
      input_tokens: 2,
      cache_creation_input_tokens: 29792,
      cache_read_input_tokens: 23538,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 29792,
      },
      output_tokens: 4,
      service_tier: 'standard',
      inference_geo: 'not_available',
    });
  });

  it('extractAssistantUsage returns undefined when no usage was reported', () => {
    expect(
      extractAssistantUsage(ASSISTANT_TOOL_USE_FIXTURE as AssistantEvent),
    ).toBeUndefined();
  });
});

describe('normalizeCliUsageToLangChainUsage', () => {
  it('sums input_tokens + cache_read + cache_creation into LangChain input_tokens (real shape: input_tokens is NEW tokens only, cache counters are additive)', () => {
    const usage: CliUsage = {
      input_tokens: 2,
      cache_creation_input_tokens: 29792,
      cache_read_input_tokens: 23538,
      output_tokens: 4,
    };
    const normalized = normalizeCliUsageToLangChainUsage(usage);
    expect(normalized).toEqual({
      input_tokens: 2 + 29792 + 23538,
      output_tokens: 4,
      total_tokens: 2 + 29792 + 23538 + 4,
      input_token_details: { cache_read: 23538, cache_creation: 29792 },
    });
  });

  it('omits input_token_details when no cache fields were reported, never fabricating zeros', () => {
    const usage: CliUsage = { input_tokens: 100, output_tokens: 50 };
    const normalized = normalizeCliUsageToLangChainUsage(usage);
    expect(normalized).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(normalized.input_token_details).toBeUndefined();
  });

  it('includes a zero cache_read explicitly when the CLI actually reported zero (not fabricated, but not omitted either)', () => {
    const usage: CliUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
    };
    const normalized = normalizeCliUsageToLangChainUsage(usage);
    expect(normalized.input_token_details).toEqual({ cache_read: 0 });
  });
});

// ── Turn event sequence validation ──────────────────────────────────────────

describe('validateTurnEventSequence', () => {
  it('returns no violations for a clean tool_use/tool_result/result sequence', () => {
    const violations = validateTurnEventSequence([
      ASSISTANT_TOOL_USE_FIXTURE,
      USER_TOOL_RESULT_FIXTURE,
      RESULT_SUCCESS_FIXTURE,
    ]);
    expect(violations).toEqual([]);
  });

  it('flags an orphan tool_result with no matching tool_use this turn', () => {
    const violations = validateTurnEventSequence([
      USER_TOOL_RESULT_FIXTURE,
      RESULT_SUCCESS_FIXTURE,
    ]);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'orphan_tool_result' }),
    );
  });

  it('flags a duplicate tool_use id within the same turn', () => {
    const violations = validateTurnEventSequence([
      ASSISTANT_TOOL_USE_FIXTURE,
      ASSISTANT_TOOL_USE_FIXTURE,
      USER_TOOL_RESULT_FIXTURE,
      RESULT_SUCCESS_FIXTURE,
    ]);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'duplicate_tool_use_id' }),
    );
  });

  it('flags a terminal result reporting success with no result text', () => {
    const inconsistentResult: StreamJsonEvent = {
      ...RESULT_SUCCESS_FIXTURE,
      result: undefined,
    };
    const violations = validateTurnEventSequence([inconsistentResult]);
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'inconsistent_terminal_result' }),
    );
  });

  it('does not flag an error result with no result text (failure, not inconsistency)', () => {
    const errorResult: StreamJsonEvent = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      session_id: 'x',
    };
    const violations = validateTurnEventSequence([errorResult]);
    expect(violations).toEqual([]);
  });
});
