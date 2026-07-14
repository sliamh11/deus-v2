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
  OLLAMA_BENCH_MODEL_ID,
  PROVIDERS,
  cellStatus,
  extractFinalAnswer,
  extractToolSequence,
  formatSummaryTable,
  isOllamaModelAvailable,
  isRateLimitError,
  makeFlakyFetchRecordTool,
  notExecutedResult,
  parseArgs,
  runChainAgainstProvider,
  runChainWithRetry,
  sequencesEqual,
  type ChainResult,
} from './lia400_tool_loop_reliability_benchmark.js';

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
