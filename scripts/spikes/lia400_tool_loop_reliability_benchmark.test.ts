import { existsSync } from 'node:fs';

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { describe, expect, it, vi } from 'vitest';

import {
  OLLAMA_SUB_MODEL_ID,
  type ExecuteOverride,
} from './lia396_provider_override_walking_skeleton.js';
import { MCP_X_DIST_PATH } from './lia398_mcp_adapter_walking_skeleton.js';
import {
  CHAINS,
  CLI_SUBPROCESS_PRE_TURN_DELAY_DEFAULT_MS,
  OLLAMA_BENCH_MODEL_ID,
  PROVIDERS,
  add,
  cellStatus,
  convertTemperature,
  createFlakyFetchRecord,
  extractCliToolSequence,
  extractFinalAnswer,
  extractToolSequence,
  formatSummaryTable,
  getWeather,
  isOllamaModelAvailable,
  isRateLimitError,
  lookupFact,
  makeFlakyFetchRecordTool,
  multiply,
  notExecutedResult,
  parseArgs,
  runChainAgainstCliSubprocess,
  runChainAgainstProvider,
  runChainWithRetry,
  runCliSubprocessChainWithRetry,
  sequencesEqual,
  setUpProviderLeg,
  type ChainResult,
} from './lia400_tool_loop_reliability_benchmark.js';
import { createLia400BenchToolsMcpServer } from './lia400-cli-subprocess-benchmark-mcp-server.js';
import type { ClaudeCliSessionPool } from '../../src/agent-runtimes/cli-subprocess/claude-cli-session-pool.js';
import type { StreamJsonEvent } from '../../src/agent-runtimes/cli-subprocess/stream-json-protocol.js';

/** Same fake-pool pattern `cli-subprocess-nested-dispatcher.test.ts` already
 *  established — a plain object cast through `unknown`, since
 *  `ClaudeCliSessionPool` is a class with private fields (nominal typing). */
function fakeCliPool(overrides: {
  sendTurn?: (
    id: string,
    prompt: string,
  ) => Promise<{
    result: { is_error: boolean; result?: string };
    turnEvents: StreamJsonEvent[];
    events?: StreamJsonEvent[];
    timing?: {
      spawnToInitMs?: number;
      spawnToFirstAssistantMs?: number;
      spawnToMcpReadyMs?: number;
      mcpReadyTimedOut?: boolean;
    };
  }>;
}): { pool: ClaudeCliSessionPool; terminateCalls: string[] } {
  const terminateCalls: string[] = [];
  const pool = {
    createConversation: vi.fn(async (id: string) => ({
      conversationId: id,
      pid: 1,
    })),
    sendTurn: vi.fn(async (id: string, prompt: string) => {
      if (overrides.sendTurn) return overrides.sendTurn(id, prompt);
      return {
        result: { is_error: false, result: 'ok' },
        turnEvents: [],
      };
    }),
    terminate: vi.fn(async (id: string) => {
      terminateCalls.push(id);
    }),
  } as unknown as ClaudeCliSessionPool;
  return { pool, terminateCalls };
}

const cliDeps = {
  repoRoot: '/repo',
  mcpServerScriptPath: '/repo/lia400-cli-subprocess-benchmark-mcp-server.ts',
  scratchDirFor: (conversationId: string) => `/tmp/scratch/${conversationId}`,
  modelId: 'claude-sonnet-5',
  // Fake, zero-delay sleep + explicit preTurnDelayMs=0: every pre-existing
  // test in this suite uses the shared cliDeps object, and the real default
  // (CLI_SUBPROCESS_PRE_TURN_DELAY_DEFAULT_MS, 3000ms) would otherwise make
  // every one of them incur a real 3s wall-clock wait.
  sleep: async () => {},
  preTurnDelayMs: 0,
};

/**
 * Live gates, mirroring A3/A5's established convention: the suite adapts to
 * what is actually available (live probe / build-artifact check) instead of
 * failing on machines without the local infra. All other tests below are
 * fully deterministic with zero network.
 */
const OLLAMA_AVAILABLE = await isOllamaModelAvailable(OLLAMA_BENCH_MODEL_ID);
const MCP_X_BUILT = existsSync(MCP_X_DIST_PATH);

/** Placeholder model for scripted runs — constructed but NEVER executed
 *  (the scripted override short-circuits every model call). */
function placeholderModel(): ChatOllama {
  return new ChatOllama({ model: OLLAMA_SUB_MODEL_ID });
}

/**
 * Scripts the MODEL side of the ReAct loop: each entry in `turns` becomes a
 * tool_calls-bearing AIMessage (one model turn), then every subsequent turn
 * returns the plain final answer — the same shape as A3's
 * makeScriptedMainStub, generalized to arbitrary tool sequences. The chain's
 * REAL tools still execute, so this tests the whole loop + scoring path.
 */
function scriptToolCalls(
  turns: Array<Array<{ name: string; args: Record<string, unknown> }>>,
  finalText: string,
): ExecuteOverride {
  let call = 0;
  return () => {
    const turn = turns[call];
    call += 1;
    if (turn !== undefined) {
      return new AIMessage({
        content: '',
        tool_calls: turn.map((toolCall, index) => ({
          name: toolCall.name,
          args: toolCall.args,
          id: `call_${call}_${index}`,
          type: 'tool_call' as const,
        })),
      });
    }
    return new AIMessage({ content: finalText });
  };
}

function chainById(id: string) {
  const chain = CHAINS.find((c) => c.id === id);
  if (!chain) throw new Error(`chain ${id} not defined`);
  return chain;
}

describe('CHAINS definition (AC1: 5-8 representative multi-step chains)', () => {
  it('defines 6 chains, within the 5-8 acceptance range, with unique ids', () => {
    expect(CHAINS.length).toBe(6);
    expect(CHAINS.length).toBeGreaterThanOrEqual(5);
    expect(CHAINS.length).toBeLessThanOrEqual(8);
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length);
  });

  it('every chain has a non-empty expected tool sequence and seed prompt', () => {
    for (const chain of CHAINS) {
      expect(chain.expectedToolSequence.length).toBeGreaterThan(0);
      expect(chain.seedPrompt.length).toBeGreaterThan(0);
    }
  });
});

describe('scoring helpers', () => {
  it('extractToolSequence returns tool-message names in order', () => {
    const messages = [
      new AIMessage({ content: '' }),
      new ToolMessage({ content: 'x', tool_call_id: '1', name: 'get_weather' }),
      new ToolMessage({
        content: 'y',
        tool_call_id: '2',
        name: 'convert_temperature',
      }),
      new AIMessage({ content: '20 celsius' }),
    ];
    expect(extractToolSequence(messages)).toEqual([
      'get_weather',
      'convert_temperature',
    ]);
  });

  it('sequencesEqual is exact (order and length)', () => {
    expect(sequencesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sequencesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sequencesEqual(['a'], ['a', 'a'])).toBe(false);
    expect(sequencesEqual([], [])).toBe(true);
  });

  it('extractFinalAnswer returns the trailing AI message content, else empty', () => {
    expect(extractFinalAnswer([new AIMessage({ content: 'final' })])).toBe(
      'final',
    );
    expect(
      extractFinalAnswer([
        new AIMessage({ content: 'final' }),
        new ToolMessage({ content: 'x', tool_call_id: '1', name: 't' }),
      ]),
    ).toBe('');
    expect(extractFinalAnswer([])).toBe('');
  });

  it('cellStatus maps not-executed / pass / fail correctly', () => {
    const base: ChainResult = {
      chainId: 'c',
      provider: 'gpt',
      succeeded: true,
      actualToolSequence: ['t'],
      expectedToolSequence: ['t'],
      matched: true,
      latencyMs: 1,
    };
    expect(cellStatus(base)).toBe('PASS');
    expect(cellStatus({ ...base, matched: false })).toBe('FAIL');
    expect(cellStatus({ ...base, succeeded: false, matched: false })).toBe(
      'FAIL',
    );
    expect(cellStatus({ ...base, notExecutedReason: 'rate limited' })).toBe(
      'NOT-EXEC',
    );
  });
});

describe('chain tool implementations (deterministic, direct invocation)', () => {
  it('lookup_fact returns the canned fact and a fallback for unknown topics', async () => {
    const setup =
      await chainById('single_tool_lookup').setup(placeholderModel());
    const lookup = setup.tools[0]!;
    expect(String(await lookup.invoke({ topic: 'Aurora' }))).toContain(
      'solar-wind',
    );
    expect(String(await lookup.invoke({ topic: 'nonexistent' }))).toContain(
      'no fact recorded',
    );
  });

  it('convert_temperature converts 68F to 20C and rejects unsupported units', async () => {
    const setup = await chainById('sequential_two_tool').setup(
      placeholderModel(),
    );
    const convert = setup.tools[1]!;
    const converted = JSON.parse(
      String(
        await convert.invoke({ value: 68, from: 'fahrenheit', to: 'celsius' }),
      ),
    ) as { value: number };
    expect(converted.value).toBe(20);
    expect(
      String(await convert.invoke({ value: 1, from: 'kelvin', to: 'celsius' })),
    ).toContain('ERROR');
  });

  it('flaky fetch_record fails on the first call and succeeds on the retry', async () => {
    const flaky = makeFlakyFetchRecordTool();
    expect(String(await flaky.invoke({ id: 'r-17' }))).toContain(
      'transient backend failure',
    );
    const second = JSON.parse(String(await flaky.invoke({ id: 'r-17' }))) as {
      id: string;
      value: string;
    };
    expect(second).toEqual({ id: 'r-17', value: 'blue-harbor' });
  });
});

describe('runChainAgainstProvider — scripted full loop (real tools, zero network)', () => {
  it('single_tool_lookup: matched=true when the scripted model calls lookup_fact once', async () => {
    const result = await runChainAgainstProvider(
      chainById('single_tool_lookup'),
      'ollama',
      placeholderModel(),
      {
        scriptedOverride: scriptToolCalls(
          [[{ name: 'lookup_fact', args: { topic: 'aurora' } }]],
          'Auroras come from solar-wind particles hitting the atmosphere.',
        ),
      },
    );
    expect(result.succeeded).toBe(true);
    expect(result.actualToolSequence).toEqual(['lookup_fact']);
    expect(result.matched).toBe(true);
    expect(result.finalAnswer?.length).toBeGreaterThan(0);
  });

  it('sequential_two_tool: matched=true for get_weather -> convert_temperature', async () => {
    const result = await runChainAgainstProvider(
      chainById('sequential_two_tool'),
      'ollama',
      placeholderModel(),
      {
        scriptedOverride: scriptToolCalls(
          [
            [{ name: 'get_weather', args: { city: 'Reykjavik' } }],
            [
              {
                name: 'convert_temperature',
                args: { value: 68, from: 'fahrenheit', to: 'celsius' },
              },
            ],
          ],
          'It is 20 celsius in Reykjavik.',
        ),
      },
    );
    expect(result.actualToolSequence).toEqual([
      'get_weather',
      'convert_temperature',
    ]);
    expect(result.matched).toBe(true);
  });

  it('calculation_chain: matched=true for add -> multiply', async () => {
    const result = await runChainAgainstProvider(
      chainById('calculation_chain'),
      'ollama',
      placeholderModel(),
      {
        scriptedOverride: scriptToolCalls(
          [
            [{ name: 'add', args: { a: 3, b: 4 } }],
            [{ name: 'multiply', args: { a: 7, b: 6 } }],
          ],
          'The final product is 42.',
        ),
      },
    );
    expect(result.actualToolSequence).toEqual(['add', 'multiply']);
    expect(result.matched).toBe(true);
  });

  it('error_recovery: matched=true only when the model retries fetch_record', async () => {
    const chain = chainById('error_recovery');
    const retried = await runChainAgainstProvider(
      chain,
      'ollama',
      placeholderModel(),
      {
        scriptedOverride: scriptToolCalls(
          [
            [{ name: 'fetch_record', args: { id: 'r-17' } }],
            [{ name: 'fetch_record', args: { id: 'r-17' } }],
          ],
          'The record value is blue-harbor.',
        ),
      },
    );
    expect(retried.actualToolSequence).toEqual([
      'fetch_record',
      'fetch_record',
    ]);
    expect(retried.matched).toBe(true);

    // Discrimination: a model that gives up after the transient error must
    // NOT be scored as matched.
    const gaveUp = await runChainAgainstProvider(
      chain,
      'ollama',
      placeholderModel(),
      {
        scriptedOverride: scriptToolCalls(
          [[{ name: 'fetch_record', args: { id: 'r-17' } }]],
          'The backend failed, giving up.',
        ),
      },
    );
    expect(gaveUp.succeeded).toBe(true);
    expect(gaveUp.actualToolSequence).toEqual(['fetch_record']);
    expect(gaveUp.matched).toBe(false);
  });

  it("delegate_to_subagent: A3's nested loop scripted on both roles, zero network", async () => {
    let subCalls = 0;
    let mainCalls = 0;
    const scriptedOverride: ExecuteOverride = (role) => {
      if (role === 'sub') {
        subCalls += 1;
        return new AIMessage({ content: 'mango' });
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'delegate_to_subagent',
              args: { task: 'What is your favorite fruit?' },
              id: 'call_1',
              type: 'tool_call',
            },
          ],
        });
      }
      return new AIMessage({ content: 'The subagent likes mango.' });
    };

    const result = await runChainAgainstProvider(
      chainById('delegate_to_subagent'),
      'claude',
      placeholderModel(),
      { scriptedOverride },
    );
    expect(result.succeeded).toBe(true);
    expect(result.actualToolSequence).toEqual(['delegate_to_subagent']);
    expect(result.matched).toBe(true);
    expect(subCalls).toBe(1);
    expect(mainCalls).toBeGreaterThanOrEqual(2);
  });

  it('records a failure result (succeeded=false) when the model call throws', async () => {
    const result = await runChainAgainstProvider(
      chainById('single_tool_lookup'),
      'gpt',
      placeholderModel(),
      {
        scriptedOverride: () => {
          throw new Error('boom: provider exploded');
        },
      },
    );
    expect(result.succeeded).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.error).toContain('boom');
    expect(result.notExecutedReason).toBeUndefined();
  });
});

describe('rate-limit handling (the Claude-leg AC3 escape hatch)', () => {
  it('isRateLimitError recognizes 429 / rate_limit / overloaded, not other errors', () => {
    expect(isRateLimitError('Request failed with status code 429')).toBe(true);
    expect(isRateLimitError('rate_limit_error: quota exceeded')).toBe(true);
    expect(isRateLimitError('Overloaded')).toBe(true);
    expect(isRateLimitError('ECONNREFUSED 127.0.0.1:3099')).toBe(false);
    expect(isRateLimitError('model not found (404)')).toBe(false);
  });

  it('runChainWithRetry retries with linear backoff then records not-executed on persistent 429', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const result = await runChainWithRetry(
      chainById('single_tool_lookup'),
      'claude',
      placeholderModel(),
      {
        scriptedOverride: () => {
          attempts += 1;
          throw new Error('429 rate_limit_error: quota exhausted');
        },
      },
      { maxRetries: 2, backoffMs: 20_000, sleep },
    );
    expect(attempts).toBe(3); // initial + 2 retries
    expect(sleeps).toEqual([20_000, 40_000]);
    expect(result.succeeded).toBe(false);
    expect(result.notExecutedReason).toContain('persistent rate-limiting');
  });

  it('runChainWithRetry recovers when a retry succeeds', async () => {
    let call = 0;
    const sleep = vi.fn(async () => {});
    const scriptedOverride: ExecuteOverride = () => {
      call += 1;
      if (call === 1) throw new Error('429 rate_limit_error');
      if (call === 2) {
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'lookup_fact',
              args: { topic: 'aurora' },
              id: 'call_1',
              type: 'tool_call',
            },
          ],
        });
      }
      return new AIMessage({ content: 'Solar wind causes auroras.' });
    };
    const result = await runChainWithRetry(
      chainById('single_tool_lookup'),
      'claude',
      placeholderModel(),
      { scriptedOverride },
      { maxRetries: 2, backoffMs: 1, sleep },
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.notExecutedReason).toBeUndefined();
  });

  it('does not retry non-rate-limit failures', async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const result = await runChainWithRetry(
      chainById('single_tool_lookup'),
      'claude',
      placeholderModel(),
      {
        scriptedOverride: () => {
          attempts += 1;
          throw new Error('invalid_request_error: bad schema');
        },
      },
      { maxRetries: 2, backoffMs: 1, sleep },
    );
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.notExecutedReason).toBeUndefined();
    expect(result.succeeded).toBe(false);
  });
});

describe('CLI arg parsing (flags mirror eval/quality_bench.py)', () => {
  it('defaults to all providers, no smoke, no dry', () => {
    expect(parseArgs([])).toEqual({
      smoke: false,
      dry: false,
      providers: [...PROVIDERS],
    });
  });

  it('parses --smoke, --dry, and --providers subsets', () => {
    expect(parseArgs(['--smoke']).smoke).toBe(true);
    expect(parseArgs(['--dry']).dry).toBe(true);
    expect(parseArgs(['--providers=gpt,ollama']).providers).toEqual([
      'gpt',
      'ollama',
    ]);
  });

  it('rejects unknown providers and unknown flags', () => {
    expect(() => parseArgs(['--providers=grok'])).toThrow(
      /unknown provider "grok"/,
    );
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown flag/);
  });

  it('parses --preTurnDelayMs, including 0 for a control run, and rejects invalid values', () => {
    expect(parseArgs(['--preTurnDelayMs=3000']).preTurnDelayMs).toBe(3000);
    expect(parseArgs(['--preTurnDelayMs=0']).preTurnDelayMs).toBe(0);
    expect(parseArgs([]).preTurnDelayMs).toBeUndefined();
    expect(() => parseArgs(['--preTurnDelayMs=-1'])).toThrow(
      /invalid --preTurnDelayMs value/,
    );
    expect(() => parseArgs(['--preTurnDelayMs=notanumber'])).toThrow(
      /invalid --preTurnDelayMs value/,
    );
  });

  it('parses --waitForMcpReady and rejects invalid values (LIA-461)', () => {
    expect(parseArgs(['--waitForMcpReady=5000']).waitForMcpReadyTimeoutMs).toBe(
      5000,
    );
    expect(parseArgs([]).waitForMcpReadyTimeoutMs).toBeUndefined();
    expect(() => parseArgs(['--waitForMcpReady=0'])).toThrow(
      /invalid --waitForMcpReady value/,
    );
    expect(() => parseArgs(['--waitForMcpReady=-1'])).toThrow(
      /invalid --waitForMcpReady value/,
    );
    expect(() => parseArgs(['--waitForMcpReady=notanumber'])).toThrow(
      /invalid --waitForMcpReady value/,
    );
  });

  it('rejects --preTurnDelayMs and --waitForMcpReady together (mutually exclusive, LIA-461)', () => {
    expect(() =>
      parseArgs(['--preTurnDelayMs=3000', '--waitForMcpReady=5000']),
    ).toThrow(/mutually exclusive/);
  });
});

describe('summary table', () => {
  it('renders one row per chain with PASS/FAIL/NOT-EXEC cells', () => {
    const chain = chainById('single_tool_lookup');
    const results: ChainResult[] = [
      {
        chainId: chain.id,
        provider: 'gpt',
        succeeded: true,
        actualToolSequence: ['lookup_fact'],
        expectedToolSequence: ['lookup_fact'],
        matched: true,
        latencyMs: 5,
      },
      notExecutedResult(chain, 'claude', 'persistent rate-limiting'),
    ];
    const table = formatSummaryTable([chain], ['claude', 'gpt'], results);
    const row = table.split('\n')[1]!;
    expect(row).toContain('single_tool_lookup');
    expect(row).toContain('NOT-EXEC');
    expect(row).toContain('PASS');
  });
});

describe('extractCliToolSequence (CLI-subprocess leg scoring adapter)', () => {
  function assistantEvent(
    blocks: Array<{ type: string; [key: string]: unknown }>,
  ): StreamJsonEvent {
    return {
      type: 'assistant',
      session_id: 's1',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: blocks },
    };
  }

  it('returns [] for events with no tool_use blocks', () => {
    expect(
      extractCliToolSequence([assistantEvent([{ type: 'text', text: 'hi' }])]),
    ).toEqual([]);
  });

  it('ignores non-assistant events (e.g. system/init, user, result)', () => {
    expect(
      extractCliToolSequence([
        { type: 'system', subtype: 'init' },
        { type: 'result', is_error: false, subtype: 'success' },
      ]),
    ).toEqual([]);
  });

  it('extracts one tool name per tool_use block, across multiple assistant events, in order', () => {
    const events: StreamJsonEvent[] = [
      assistantEvent([
        { type: 'tool_use', id: 't1', name: 'get_weather', input: {} },
      ]),
      assistantEvent([
        { type: 'text', text: 'converting now' },
        {
          type: 'tool_use',
          id: 't2',
          name: 'convert_temperature',
          input: {},
        },
      ]),
    ];
    expect(extractCliToolSequence(events)).toEqual([
      'get_weather',
      'convert_temperature',
    ]);
  });

  it("regression (real credentialed run, 2026-07-20): strips the mcp__<server>__ qualification prefix the real CLI actually reports, so the result is directly comparable to expectedToolSequence's bare names", () => {
    const events: StreamJsonEvent[] = [
      assistantEvent([
        {
          type: 'tool_use',
          id: 't1',
          name: 'mcp__lia400_bench_tools__get_weather',
          input: {},
        },
      ]),
      assistantEvent([
        {
          type: 'tool_use',
          id: 't2',
          name: 'mcp__lia400_bench_tools__convert_temperature',
          input: {},
        },
      ]),
    ];
    expect(extractCliToolSequence(events)).toEqual([
      'get_weather',
      'convert_temperature',
    ]);
  });
});

describe('shared framework-agnostic tool handlers (direct invocation, reused by both the LangChain tool() wrappers and the CLI-subprocess benchmark MCP server)', () => {
  it('lookupFact returns the canned fact and a fallback for unknown topics', async () => {
    expect(await lookupFact({ topic: 'Aurora' })).toContain('solar-wind');
    expect(await lookupFact({ topic: 'nonexistent' })).toContain(
      'no fact recorded',
    );
  });

  it('getWeather returns a fixed 68F reading', async () => {
    const parsed = JSON.parse(await getWeather({ city: 'Reykjavik' })) as {
      temperature: number;
      unit: string;
    };
    expect(parsed).toEqual({
      city: 'Reykjavik',
      temperature: 68,
      unit: 'fahrenheit',
    });
  });

  it('convertTemperature converts 68F to 20C and rejects unsupported units', async () => {
    const converted = JSON.parse(
      await convertTemperature({
        value: 68,
        from: 'fahrenheit',
        to: 'celsius',
      }),
    ) as { value: number };
    expect(converted.value).toBe(20);
    expect(
      await convertTemperature({ value: 1, from: 'kelvin', to: 'celsius' }),
    ).toContain('ERROR');
  });

  it('add and multiply compose to the expected 6-hop total', async () => {
    expect(await add({ a: 3, b: 4 })).toBe('7');
    expect(await multiply({ a: 7, b: 6 })).toBe('42');
  });

  it('createFlakyFetchRecord gives every fresh handler its own failure counter', async () => {
    const first = createFlakyFetchRecord();
    const second = createFlakyFetchRecord();
    expect(await first({ id: 'r-17' })).toContain('transient backend failure');
    // A second, independently-created handler is NOT affected by the first's
    // call count — proves the counter is per-handler-instance, matching the
    // guarantee a fresh MCP server process gives the CLI-subprocess leg.
    expect(await second({ id: 'r-17' })).toContain('transient backend failure');
    expect(JSON.parse(await first({ id: 'r-17' }))).toEqual({
      id: 'r-17',
      value: 'blue-harbor',
    });
  });
});

describe('runChainAgainstCliSubprocess / runCliSubprocessChainWithRetry (code-review finding: preserving the real is_error text)', () => {
  const chain = chainById('single_tool_lookup');

  it("an is_error turn preserves the CLI's real reported text as `error`, not a generic placeholder", async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: {
          is_error: true,
          result: '429 rate_limit_error: overloaded, please retry',
        },
        turnEvents: [],
      }),
    });
    const result = await runChainAgainstCliSubprocess(chain, pool, cliDeps);
    expect(result.succeeded).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.finalAnswer).toBe('');
    // The regression this guards: forcing `error` to a fixed constant here
    // would make isRateLimitError never match, and the cell would score a
    // hard FAIL instead of NOT-EXEC for an external/environmental blocker.
    expect(result.error).toBe('429 rate_limit_error: overloaded, please retry');
    expect(isRateLimitError(result.error!)).toBe(true);
  });

  it('runCliSubprocessChainWithRetry reclassifies a persistent rate-limit error to NOT-EXEC, never FAIL', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: true, result: '429 overloaded' },
        turnEvents: [],
      }),
    });
    const result = await runCliSubprocessChainWithRetry(chain, pool, cliDeps, {
      maxRetries: 1,
      backoffMs: 0,
      sleep: async () => {},
    });
    expect(cellStatus(result)).toBe('NOT-EXEC');
    expect(result.notExecutedReason).toBeDefined();
  });

  it('a non-rate-limit is_error turn scores a real FAIL (not silently swallowed as NOT-EXEC)', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: true, result: 'tool schema validation failed' },
        turnEvents: [],
      }),
    });
    const result = await runCliSubprocessChainWithRetry(chain, pool, cliDeps, {
      maxRetries: 1,
      backoffMs: 0,
      sleep: async () => {},
    });
    expect(cellStatus(result)).toBe('FAIL');
  });

  it('a successful turn extracts the tool sequence and final answer correctly', async () => {
    const { pool, terminateCalls } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [
          {
            type: 'assistant',
            session_id: 's1',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 't1', name: 'lookup_fact', input: {} },
              ],
            },
          },
        ],
      }),
    });
    const result = await runChainAgainstCliSubprocess(chain, pool, cliDeps);
    expect(result.succeeded).toBe(true);
    expect(result.actualToolSequence).toEqual(['lookup_fact']);
    expect(result.matched).toBe(true);
    expect(result.finalAnswer).toBe('the aurora fact');
    // terminate() must be called even on the success path (finally block).
    expect(terminateCalls.length).toBe(1);
    // code-review finding: no `events` supplied (as in every other
    // pre-existing test here) means no system/init event is found, so the
    // init-derived fields stay absent — but cliMcpDiagnostics itself is
    // still present, with preTurnDelayMs always recorded regardless of
    // whether init data was observed.
    expect(result.cliMcpDiagnostics).toEqual({ preTurnDelayMs: 0 });
  });

  it('records preTurnDelayMs even when no system/init event was ever observed (the exact failure mode under investigation)', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [],
        events: [], // no system/init at all — MCP handshake never completed
      }),
    });
    const result = await runChainAgainstCliSubprocess(chain, pool, {
      ...cliDeps,
      preTurnDelayMs: 777,
    });
    expect(result.cliMcpDiagnostics).toEqual({ preTurnDelayMs: 777 });
  });

  it('records preTurnDelayMs on a spawn/protocol failure that never reaches sendTurn', async () => {
    const { pool } = fakeCliPool({});
    (
      pool.createConversation as unknown as {
        mockRejectedValueOnce: (err: Error) => void;
      }
    ).mockRejectedValueOnce(new Error('spawn ENOENT'));
    const result = await runChainAgainstCliSubprocess(chain, pool, {
      ...cliDeps,
      preTurnDelayMs: 999,
    });
    expect(result.succeeded).toBe(false);
    expect(result.cliMcpDiagnostics).toEqual({ preTurnDelayMs: 999 });
  });

  it("attaches cliMcpDiagnostics from the turn's system/init event + timing when present", async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [
          {
            type: 'assistant',
            session_id: 's1',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 't1', name: 'lookup_fact', input: {} },
              ],
            },
          },
        ],
        events: [
          {
            type: 'system',
            subtype: 'init',
            session_id: 's1',
            mcp_servers: [{ name: 'lia400_bench_tools', status: 'connected' }],
            tools: ['lookup_fact'],
          },
        ],
        timing: { spawnToInitMs: 500, spawnToFirstAssistantMs: 800 },
      }),
    });
    const result = await runChainAgainstCliSubprocess(chain, pool, cliDeps);
    expect(result.cliMcpDiagnostics).toEqual({
      mcpServers: [{ name: 'lia400_bench_tools', status: 'connected' }],
      toolsAtInit: ['lookup_fact'],
      spawnToInitMs: 500,
      spawnToFirstAssistantMs: 800,
      preTurnDelayMs: 0,
    });
  });

  it('awaits the pre-turn delay between createConversation and sendTurn, and records the applied delay', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [],
      }),
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await runChainAgainstCliSubprocess(chain, pool, {
      ...cliDeps,
      sleep,
      preTurnDelayMs: 1234,
    });
    const createConversationMock = pool.createConversation as unknown as {
      mock: { invocationCallOrder: number[] };
    };
    const sendTurnMock = pool.sendTurn as unknown as {
      mock: { invocationCallOrder: number[] };
    };
    expect(createConversationMock.mock.invocationCallOrder[0]!).toBeLessThan(
      sleep.mock.invocationCallOrder[0]!,
    );
    expect(sleep.mock.invocationCallOrder[0]!).toBeLessThan(
      sendTurnMock.mock.invocationCallOrder[0]!,
    );
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(result.succeeded).toBe(true);
  });

  it('falls back to CLI_SUBPROCESS_PRE_TURN_DELAY_DEFAULT_MS and the real defaultSleep when neither is overridden', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakeCliPool({
        sendTurn: async () => ({
          result: { is_error: false, result: 'the aurora fact' },
          turnEvents: [],
        }),
      });
      // Omit sleep/preTurnDelayMs entirely — the real code path main() hits
      // whenever --preTurnDelayMs isn't passed on the command line.
      const {
        sleep: _sleep,
        preTurnDelayMs: _delay,
        ...depsWithoutOverrides
      } = cliDeps;
      const resultPromise = runChainAgainstCliSubprocess(
        chain,
        pool,
        depsWithoutOverrides,
      );
      // defaultSleep uses the real setTimeout; advance fake time past the
      // default delay so the awaited promise actually resolves.
      await vi.advanceTimersByTimeAsync(
        CLI_SUBPROCESS_PRE_TURN_DELAY_DEFAULT_MS,
      );
      const result = await resultPromise;
      expect(result.succeeded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('threads waitForMcpReady straight through to createConversation and skips the flat delay (LIA-461)', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [],
        timing: { spawnToMcpReadyMs: 812 },
      }),
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await runChainAgainstCliSubprocess(chain, pool, {
      ...cliDeps,
      sleep,
      preTurnDelayMs: 0,
      waitForMcpReady: { timeoutMs: 5000 },
    });
    expect(pool.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        waitForMcpReady: { timeoutMs: 5000 },
      }),
    );
    // preTurnDelayMs: 0 means the sleep resolves instantly regardless — this
    // just confirms the wiring doesn't ALSO force a real wait when the
    // marker-based mechanism is what's under test.
    expect(sleep).toHaveBeenCalledWith(0);
    expect(result.cliMcpDiagnostics?.spawnToMcpReadyMs).toBe(812);
  });

  it('omits waitForMcpReady from createConversation when not requested (default-unchanged)', async () => {
    const { pool } = fakeCliPool({
      sendTurn: async () => ({
        result: { is_error: false, result: 'the aurora fact' },
        turnEvents: [],
      }),
    });
    await runChainAgainstCliSubprocess(chain, pool, cliDeps);
    const call = (
      pool.createConversation as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0]![1] as Record<string, unknown>;
    expect(call).not.toHaveProperty('waitForMcpReady');
  });
});

describe('claude-cli-subprocess provider leg', () => {
  it('setUpProviderLeg("claude-cli-subprocess") returns an available leg with a pool, not a LangChain model', async () => {
    const leg = await setUpProviderLeg('claude-cli-subprocess');
    expect(leg.name).toBe('claude-cli-subprocess');
    expect(leg.available).toBe(true);
    expect(leg.model).toBeUndefined();
    expect(leg.pool).toBeDefined();
    expect(leg.modelId).toContain('claude-cli-subprocess');
    // cleanup must resolve without throwing even though no conversation was
    // ever created against this pool (mirrors the other 3 legs' cleanup
    // being safe to call unconditionally in main()'s finally block).
    await expect(leg.cleanup?.()).resolves.toBeUndefined();
  });
});

describe('lia400-cli-subprocess-benchmark-mcp-server (construction smoke, no real subprocess)', () => {
  it('constructs a server registering all 8 benchmark tools and shuts down cleanly with no calls made', async () => {
    const { server, shutdown } = createLia400BenchToolsMcpServer();
    expect(server).toBeDefined();
    // No tool was ever invoked, so neither the nested pool nor the mcp-x
    // client should have been constructed — shutdown must still resolve
    // cleanly against that all-undefined state (mirrors
    // parent-turn-mcp-server.ts's own shutdown()'s `nestedPool?.shutdownAll()`
    // optional-chaining posture).
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

describe('live mcp-x tool discovery (gated on the local dist build)', () => {
  const maybeIt = MCP_X_BUILT ? it : it.skip;

  maybeIt(
    'discovers get_status among mcp-x tools (no credentials, no model call)',
    async () => {
      const { createMcpXClient } =
        await import('./lia398_mcp_adapter_walking_skeleton.js');
      const client = createMcpXClient();
      try {
        const tools = await client.getTools('mcp-x');
        expect(tools.map((t) => t.name)).toContain('get_status');
      } finally {
        await client.close();
      }
    },
    30_000,
  );
});

describe('live Ollama provider smoke (gated on daemon + model availability)', () => {
  const maybeIt = OLLAMA_AVAILABLE ? it : it.skip;

  maybeIt(
    'runs single_tool_lookup against live gemma4:e2b and returns a well-formed result',
    async () => {
      const result = await runChainAgainstProvider(
        chainById('single_tool_lookup'),
        'ollama',
        new ChatOllama({ model: OLLAMA_BENCH_MODEL_ID }),
      );
      // Deliberately does NOT assert matched=true: whether a small local
      // model completes the chain is the BENCHMARK's signal (recorded in the
      // results grid), not this suite's correctness criterion. The suite
      // asserts the runner produces a well-formed, honest result either way.
      expect(typeof result.succeeded).toBe('boolean');
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.expectedToolSequence).toEqual(['lookup_fact']);
      expect(result.notExecutedReason).toBeUndefined();
    },
    120_000,
  );
});
