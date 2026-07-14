import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseMessage } from '@langchain/core/messages';
import type { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import {
  createAgent,
  tool,
  type AgentMiddleware,
  type ModelRequest,
} from 'langchain';

// A3's reviewed provider-routing middleware, imported rather than re-derived —
// its module comment already anticipates this reuse ("A7 supplies its own
// resolver per benchmark matrix cell").
import {
  OLLAMA_BASE_URL,
  OLLAMA_SUB_MODEL_ID,
  createProviderRoutingMiddleware,
  makeDelegateToSubagentTool,
  type ExecuteOverride,
  type ProviderResolver,
} from './lia396_provider_override_walking_skeleton.js';
// A4's reviewed isolated proxy-child mechanism — this spike NEVER routes
// through the live :3001 daemon (same reuse decision as A5).
import {
  buildProxyRoutedChatAnthropic,
  spawnProxyChild,
  waitForChildReady,
} from './lia397_credential_proxy_billing_spike.js';
// A5's reviewed mcp-x client — the one real-infra chain (get_status is the
// tool A5's doc records as safe with zero credentials).
import {
  assertMcpXBuilt,
  createMcpXClient,
} from './lia398_mcp_adapter_walking_skeleton.js';

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));

export const RESULTS_PATH = path.join(
  spikeDirectory,
  'lia400_tool_loop_reliability_benchmark.results.json',
);

// Mirrors the production OpenAI backend's model resolution
// (container/agent-runner/src/openai-backend.ts:387,499:
// `process.env.DEUS_OPENAI_MODEL || 'gpt-4o'`) rather than the codex-CLI
// model ids (gpt-5.5/gpt-5.4), which name CLI-side config, not the direct
// chat-completions API this leg uses.
export const GPT_MODEL_ID = process.env.DEUS_OPENAI_MODEL ?? 'gpt-4o';

// The Ollama benchmark leg uses the same tool-capable local model A3 already
// validated as OLLAMA_SUB_MODEL_ID (gemma4:e2b).
export const OLLAMA_BENCH_MODEL_ID = OLLAMA_SUB_MODEL_ID;

export const PROVIDERS = ['claude', 'gpt', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

// createAgent's model parameter type, borrowed the same way A3 does for its
// placeholder-model plumbing.
export type BenchModel = ModelRequest['model'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Same guard as A5's stringifyContent (lia398:61-68, not exported there):
// JSON.stringify(undefined) returns runtime `undefined` despite TS typing it
// as `string`, so it needs an explicit fallback.
function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content) ?? String(content);
}

// ── Chain definitions ────────────────────────────────────────────────────

/**
 * Per-run dependencies a chain's setup may need.
 * - mcpClient: only the mcp_get_status chain uses it.
 * - scriptedOverride: test-only seam — scripts the MODEL side of the loop
 *   (via A3's ExecuteOverride) while the chain's real tools still execute,
 *   so the whole scoring path is testable deterministically with zero
 *   network. Live benchmark runs never set it.
 */
export interface ChainDependencies {
  mcpClient?: MultiServerMCPClient;
  scriptedOverride?: ExecuteOverride;
}

export interface ChainSetup {
  tools: Array<ReturnType<typeof tool>>;
  /** Only the delegate_to_subagent chain supplies middleware (A3's routing
   *  middleware, which its tool closes over). Plain chains supply none. */
  middleware?: AgentMiddleware[];
  /** invoke-time context (e.g. { role: 'main' } for the delegate chain). */
  invokeContext?: Record<string, unknown>;
}

export interface ToolChainDefinition {
  id: string;
  description: string;
  seedPrompt: string;
  /** The mechanically-checked expected tool-call sequence, in order. */
  expectedToolSequence: string[];
  /** True only for mcp_get_status — needs deps.mcpClient. */
  requiresMcp?: boolean;
  /** True only for delegate_to_subagent — its sub leg is a live local
   *  Ollama call, so the chain is environment-gated on Ollama in live runs. */
  requiresOllamaSubLeg?: boolean;
  setup(
    model: BenchModel,
    deps?: ChainDependencies,
  ): ChainSetup | Promise<ChainSetup>;
}

const FACT_KB: Record<string, string> = {
  aurora:
    'Auroras are caused by charged solar-wind particles colliding with gases in the upper atmosphere.',
};

function makeLookupFactTool() {
  return tool(
    async (args: { topic: string }) =>
      FACT_KB[args.topic.toLowerCase()] ??
      `no fact recorded for topic "${args.topic}"`,
    {
      name: 'lookup_fact',
      description: 'Looks up a canned fact by topic keyword.',
      schema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  );
}

function makeWeatherTools() {
  const getWeather = tool(
    async (args: { city: string }) =>
      JSON.stringify({ city: args.city, temperature: 68, unit: 'fahrenheit' }),
    {
      name: 'get_weather',
      description: 'Returns the current temperature for a city, in fahrenheit.',
      schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  );
  const convertTemperature = tool(
    async (args: { value: number; from: string; to: string }) => {
      const from = args.from.toLowerCase();
      const to = args.to.toLowerCase();
      let converted: number;
      if (from.startsWith('f') && to.startsWith('c')) {
        converted = ((args.value - 32) * 5) / 9;
      } else if (from.startsWith('c') && to.startsWith('f')) {
        converted = (args.value * 9) / 5 + 32;
      } else {
        return `ERROR: unsupported conversion ${args.from} -> ${args.to}`;
      }
      return JSON.stringify({
        value: Math.round(converted * 100) / 100,
        unit: to,
      });
    },
    {
      name: 'convert_temperature',
      description:
        'Converts a temperature value between fahrenheit and celsius.',
      schema: {
        type: 'object',
        properties: {
          value: { type: 'number' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['value', 'from', 'to'],
        additionalProperties: false,
      },
    },
  );
  return [getWeather, convertTemperature];
}

function makeCalculationTools() {
  const add = tool(
    async (args: { a: number; b: number }) => String(args.a + args.b),
    {
      name: 'add',
      description: 'Adds two numbers.',
      schema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  );
  const multiply = tool(
    async (args: { a: number; b: number }) => String(args.a * args.b),
    {
      name: 'multiply',
      description: 'Multiplies two numbers.',
      schema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  );
  return [add, multiply];
}

/**
 * Stateful per-setup closure: fails on the FIRST invocation with an
 * explicitly retryable error message, succeeds on every subsequent one —
 * checks whether the provider retries appropriately vs gives up. Returned
 * as a factory so every benchmark run gets a fresh failure counter.
 */
export function makeFlakyFetchRecordTool() {
  let calls = 0;
  return tool(
    async (args: { id: string }) => {
      calls += 1;
      if (calls === 1) {
        return 'ERROR: transient backend failure — please call fetch_record again with the same id.';
      }
      return JSON.stringify({ id: args.id, value: 'blue-harbor' });
    },
    {
      name: 'fetch_record',
      description:
        'Fetches a record by id. The backend is flaky and may report a transient error; retrying the same call succeeds.',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  );
}

export const CHAINS: ToolChainDefinition[] = [
  {
    id: 'single_tool_lookup',
    description: 'Single-hop: one lookup_fact call against a canned KB.',
    seedPrompt:
      'Use the lookup_fact tool to find the recorded fact for the topic "aurora", then state that fact in one sentence.',
    expectedToolSequence: ['lookup_fact'],
    setup: () => ({ tools: [makeLookupFactTool()] }),
  },
  {
    id: 'sequential_two_tool',
    description:
      'Two-hop: get_weather then convert_temperature, the second call must use the first call’s result.',
    seedPrompt:
      'What is the current temperature in Reykjavik in celsius? Use the get_weather tool (it reports fahrenheit), then use the convert_temperature tool to convert the reported value to celsius. Report the celsius number.',
    expectedToolSequence: ['get_weather', 'convert_temperature'],
    setup: () => ({ tools: makeWeatherTools() }),
  },
  {
    id: 'calculation_chain',
    description: 'Two-hop arithmetic: add(3,4) then multiply(result, 6).',
    seedPrompt:
      'Using the tools only (no mental math): first add 3 and 4 with the add tool, then multiply that result by 6 with the multiply tool. Report the final product.',
    expectedToolSequence: ['add', 'multiply'],
    setup: () => ({ tools: makeCalculationTools() }),
  },
  {
    id: 'delegate_to_subagent',
    description:
      "A3's real nested-delegation implementation: main provider -> delegate_to_subagent tool -> nested createAgent on local Ollama -> result back to main.",
    seedPrompt:
      'Delegate to your subagent to find out its favorite fruit, then report back.',
    expectedToolSequence: ['delegate_to_subagent'],
    requiresOllamaSubLeg: true,
    setup: (model, deps) => {
      // A7's own resolver per benchmark matrix cell (exactly the seam A3's
      // module comment reserves): 'main' -> the provider under benchmark,
      // 'sub' -> the same local Ollama model A3 validated.
      const resolveModel: ProviderResolver = (role, request) => {
        if (role === 'main') return model;
        if (role === 'sub') {
          return new ChatOllama({
            model: OLLAMA_SUB_MODEL_ID,
            baseUrl: OLLAMA_BASE_URL,
          });
        }
        return request.model;
      };
      const { middleware } = createProviderRoutingMiddleware({
        resolveModel,
        executeOverride: deps?.scriptedOverride,
      });
      return {
        tools: [makeDelegateToSubagentTool(middleware, model)],
        middleware: [middleware],
        invokeContext: { role: 'main' },
      };
    },
  },
  {
    id: 'error_recovery',
    description:
      'A tool that fails on its first invocation with a retryable error and succeeds on the retry — checks retry-vs-give-up behavior.',
    seedPrompt:
      'Fetch record "r-17" with the fetch_record tool and report its value. The backend is flaky: if the tool reports a transient error, call it again with the same id before giving up.',
    expectedToolSequence: ['fetch_record', 'fetch_record'],
    setup: () => ({ tools: [makeFlakyFetchRecordTool()] }),
  },
  {
    id: 'mcp_get_status',
    description:
      "Real infra, not synthetic: A5's mcp-x MCP server's get_status tool via MultiServerMCPClient (zero credentials needed).",
    seedPrompt: 'Check whether X credentials are configured and tell me.',
    expectedToolSequence: ['get_status'],
    requiresMcp: true,
    setup: async (_model, deps) => {
      if (!deps?.mcpClient) {
        throw new Error(
          'mcp_get_status chain requires deps.mcpClient (see createMcpXClient)',
        );
      }
      const tools = await deps.mcpClient.getTools('mcp-x');
      // The mcp-x server exposes several tools (post_tweet, get_timeline, …);
      // the agent gets ONLY get_status so the benchmark can never invoke a
      // credentialed/side-effecting tool by accident.
      const statusTool = tools.find((t) => t.name === 'get_status');
      if (!statusTool) {
        throw new Error(
          'get_status not found among mcp-x tools: ' +
            tools.map((t) => t.name).join(', '),
        );
      }
      // MultiServerMCPClient's DynamicStructuredTool and langchain's own
      // tool()-returned type both satisfy the same structural tool
      // interface createAgent expects (name/description/schema/invoke) --
      // TS can't unify the two packages' separately-declared types, so the
      // cast through unknown is the only way to hand an MCP-discovered tool
      // to createAgent's tools array.
      return { tools: [statusTool as unknown as ReturnType<typeof tool>] };
    },
  },
];

// ── Scoring (mechanical, per the plan's methodology divergence from
//    quality_bench.py's LLM-judge — tool-loop correctness is objectively
//    checkable in code) ───────────────────────────────────────────────────

export function extractToolSequence(messages: BaseMessage[]): string[] {
  return messages
    .filter((message) => message.getType() === 'tool')
    .map((message) => (message as { name?: string }).name ?? '(unnamed)');
}

export function sequencesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function extractFinalAnswer(messages: BaseMessage[]): string {
  const last = messages[messages.length - 1];
  if (last === undefined || last.getType() !== 'ai') return '';
  return stringifyContent(last.content);
}

export interface ChainResult {
  chainId: string;
  provider: ProviderName;
  /** true = agent.invoke completed without throwing. */
  succeeded: boolean;
  actualToolSequence: string[];
  expectedToolSequence: string[];
  /** true = expected sequence matched exactly AND final answer non-empty. */
  matched: boolean;
  finalAnswer?: string;
  error?: string;
  /** Set only when the cell was never a real attempt (provider unavailable,
   *  persistent rate-limiting, missing infra) — reported as NOT-EXEC, never
   *  as a false fail. */
  notExecutedReason?: string;
  latencyMs: number;
}

export function cellStatus(result: ChainResult): 'PASS' | 'FAIL' | 'NOT-EXEC' {
  if (result.notExecutedReason !== undefined) return 'NOT-EXEC';
  return result.succeeded && result.matched ? 'PASS' : 'FAIL';
}

// ── Runner ───────────────────────────────────────────────────────────────

/**
 * Builds a createAgent for the chain under the given provider model, invokes
 * it with the chain's seed prompt, and scores the actual tool-call sequence
 * against the expected one. Middleware is only present for the delegate chain
 * (its own routing middleware) or in scripted test mode.
 */
export async function runChainAgainstProvider(
  chain: ToolChainDefinition,
  provider: ProviderName,
  model: BenchModel,
  deps?: ChainDependencies,
): Promise<ChainResult> {
  const started = Date.now();
  const base = {
    chainId: chain.id,
    provider,
    expectedToolSequence: chain.expectedToolSequence,
  };
  try {
    const setup = await chain.setup(model, deps);
    const middleware = [...(setup.middleware ?? [])];
    if (deps?.scriptedOverride && setup.middleware === undefined) {
      // Test-only: plain chains get a pass-through routing middleware whose
      // executeOverride scripts the model turns (real tools still run).
      const { middleware: scripted } = createProviderRoutingMiddleware({
        resolveModel: (_role, request) => request.model,
        executeOverride: deps.scriptedOverride,
      });
      middleware.push(scripted);
    }

    const agent = createAgent({ model, tools: setup.tools, middleware });
    const invocation =
      setup.invokeContext === undefined
        ? agent.invoke({
            messages: [{ role: 'user', content: chain.seedPrompt }],
          })
        : agent.invoke(
            { messages: [{ role: 'user', content: chain.seedPrompt }] },
            { context: setup.invokeContext },
          );
    const result = await invocation;
    // Same generic-narrowing cast A5 documents (lia398:139-145).
    const messages = (result as { messages: BaseMessage[] }).messages;
    const actualToolSequence = extractToolSequence(messages);
    const finalAnswer = extractFinalAnswer(messages);
    return {
      ...base,
      succeeded: true,
      actualToolSequence,
      matched:
        sequencesEqual(actualToolSequence, chain.expectedToolSequence) &&
        finalAnswer.length > 0,
      finalAnswer,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      succeeded: false,
      actualToolSequence: [],
      matched: false,
      error: errorMessage(error),
      latencyMs: Date.now() - started,
    };
  }
}

export function isRateLimitError(message: string): boolean {
  return /(^|\D)429(\D|$)|rate.?limit|overloaded/i.test(message);
}

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  maxRetries: number;
  backoffMs: number;
  sleep?: Sleep;
}

/**
 * Bounded runner-level retries on top of any provider SDK's own internal
 * retries (3 attempts, observed by A4, for Anthropic specifically). If the
 * chain still fails with a rate-limit-CLASS error after all retries, the
 * cell is recorded as not-executed rather than a fabricated pass/fail --
 * the AC3 escape hatch. isRateLimitError's 429 pattern also matches
 * OpenAI's billing/quota-exhaustion 429 ("insufficient_quota"), which is
 * the same category of external, environmental blocker as an Anthropic
 * rate limit -- neither is signal about whether the provider's tool-calling
 * MECHANISM works, so both must reclassify to NOT-EXEC rather than FAIL.
 * Originally scoped to the Claude leg only; generalized after a live GPT
 * run hit `insufficient_quota` and was incorrectly recorded as FAIL on all
 * 6 chains -- see the kill-switch aggregation rubric in .claude/.plan-scope-a7.md,
 * which explicitly treats "an external/environmental blocker (429, missing
 * key)" as an isolated, not structural, failure.
 */
export async function runChainWithRetry(
  chain: ToolChainDefinition,
  provider: ProviderName,
  model: BenchModel,
  deps: ChainDependencies | undefined,
  options: RetryOptions,
): Promise<ChainResult> {
  const sleep = options.sleep ?? defaultSleep;
  let result = await runChainAgainstProvider(chain, provider, model, deps);
  let attempt = 0;
  while (
    !result.succeeded &&
    result.error !== undefined &&
    isRateLimitError(result.error) &&
    attempt < options.maxRetries
  ) {
    attempt += 1;
    await sleep(options.backoffMs * attempt);
    result = await runChainAgainstProvider(chain, provider, model, deps);
  }
  if (
    !result.succeeded &&
    result.error !== undefined &&
    isRateLimitError(result.error)
  ) {
    return {
      ...result,
      notExecutedReason: `not executed due to persistent rate-limiting (still 429 after ${options.maxRetries} runner-level retries on top of the SDK's internal retries)`,
    };
  }
  return result;
}

export function notExecutedResult(
  chain: ToolChainDefinition,
  provider: ProviderName,
  reason: string,
): ChainResult {
  return {
    chainId: chain.id,
    provider,
    succeeded: false,
    actualToolSequence: [],
    expectedToolSequence: chain.expectedToolSequence,
    matched: false,
    notExecutedReason: reason,
    latencyMs: 0,
  };
}

// ── Provider legs ────────────────────────────────────────────────────────

export interface ProviderLeg {
  name: ProviderName;
  available: boolean;
  reason?: string;
  modelId?: string;
  model?: BenchModel;
  cleanup?: () => void | Promise<void>;
}

/** Same live probe shape as A3's test-side gate: daemon reachable AND the
 *  specific model present in /api/tags. */
export async function isOllamaModelAvailable(
  modelId: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    return (body.models ?? []).some(
      (m) => m.name === modelId || m.model === modelId,
    );
  } catch {
    return false;
  }
}

async function setUpClaudeLeg(): Promise<ProviderLeg> {
  const port = Number(process.env.SPIKE_PROXY_PORT ?? '3099');
  const child = spawnProxyChild(port);
  try {
    const readiness = await waitForChildReady(child, 10_000);
    if (readiness.outcome !== 'started') {
      child.kill();
      return {
        name: 'claude',
        available: false,
        reason: `proxy child declined startup: ${readiness.reason}`,
      };
    }
    // Unlike A4 (which validated the subscription/OAuth BILLING path and so
    // required authMode === 'oauth'), tool-loop reliability is billing-mode
    // agnostic — either proxy auth mode exercises the same tool-calling
    // mechanism, so both are accepted (and recorded).
    return {
      name: 'claude',
      available: true,
      modelId: `claude via proxy (authMode=${readiness.authMode})`,
      model: buildProxyRoutedChatAnthropic(`http://127.0.0.1:${port}`),
      cleanup: () => {
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    return {
      name: 'claude',
      available: false,
      reason: `proxy child failed to start: ${errorMessage(error)}`,
    };
  }
}

function setUpGptLeg(): ProviderLeg {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    // Symmetric AC3 escape hatch to the Claude-429 path: recorded, never
    // silently skipped.
    return {
      name: 'gpt',
      available: false,
      reason:
        'not executed — OPENAI_API_KEY unavailable in this shell environment',
    };
  }
  return {
    name: 'gpt',
    available: true,
    modelId: GPT_MODEL_ID,
    model: new ChatOpenAI({ model: GPT_MODEL_ID, apiKey }),
  };
}

async function setUpOllamaLeg(): Promise<ProviderLeg> {
  if (!(await isOllamaModelAvailable(OLLAMA_BENCH_MODEL_ID))) {
    return {
      name: 'ollama',
      available: false,
      reason: `not executed — Ollama unreachable at ${OLLAMA_BASE_URL} or model ${OLLAMA_BENCH_MODEL_ID} not pulled`,
    };
  }
  return {
    name: 'ollama',
    available: true,
    modelId: OLLAMA_BENCH_MODEL_ID,
    model: new ChatOllama({
      model: OLLAMA_BENCH_MODEL_ID,
      baseUrl: OLLAMA_BASE_URL,
    }),
  };
}

export async function setUpProviderLeg(
  name: ProviderName,
): Promise<ProviderLeg> {
  if (name === 'claude') return setUpClaudeLeg();
  if (name === 'gpt') return setUpGptLeg();
  return setUpOllamaLeg();
}

// ── CLI (flags mirror eval/quality_bench.py: --smoke / --dry) ────────────

export interface CliArgs {
  smoke: boolean;
  dry: boolean;
  providers: ProviderName[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { smoke: false, dry: false, providers: [...PROVIDERS] };
  for (const raw of argv) {
    if (raw === '--smoke') {
      args.smoke = true;
    } else if (raw === '--dry') {
      args.dry = true;
    } else if (raw.startsWith('--providers=')) {
      const requested = raw
        .slice('--providers='.length)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      for (const provider of requested) {
        if (!(PROVIDERS as readonly string[]).includes(provider)) {
          throw new Error(
            `unknown provider "${provider}" (expected: ${PROVIDERS.join(', ')})`,
          );
        }
      }
      args.providers = requested as ProviderName[];
    } else {
      throw new Error(
        `unknown flag "${raw}" (expected --smoke, --dry, --providers=...)`,
      );
    }
  }
  return args;
}

export function formatSummaryTable(
  chains: ToolChainDefinition[],
  providers: ProviderName[],
  results: ChainResult[],
): string {
  const chainColumn = 24;
  const cell = 10;
  const header =
    'chain'.padEnd(chainColumn) + providers.map((p) => p.padEnd(cell)).join('');
  const rows = chains.map((chain) => {
    const cells = providers.map((provider) => {
      const result = results.find(
        (r) => r.chainId === chain.id && r.provider === provider,
      );
      return (result === undefined ? '—' : cellStatus(result)).padEnd(cell);
    });
    return chain.id.padEnd(chainColumn) + cells.join('');
  });
  return [header, ...rows].join('\n');
}

// ── Direct-execution benchmark run ───────────────────────────────────────

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  const chains = args.smoke ? CHAINS.slice(0, 1) : CHAINS;

  if (args.dry) {
    for (const chain of chains) {
      console.log(
        `${chain.id}: expects [${chain.expectedToolSequence.join(' -> ')}] — ${chain.description}`,
      );
    }
    return;
  }

  // mcp-x is a build-time prerequisite for the one real-infra chain; a
  // missing build marks that chain not-executed rather than crashing the run.
  let mcpClient: MultiServerMCPClient | undefined;
  let mcpUnavailableReason: string | undefined;
  if (chains.some((chain) => chain.requiresMcp)) {
    try {
      assertMcpXBuilt();
      mcpClient = createMcpXClient();
    } catch (error) {
      mcpUnavailableReason = errorMessage(error);
    }
  }
  const ollamaSubLegUp = chains.some((chain) => chain.requiresOllamaSubLeg)
    ? await isOllamaModelAvailable(OLLAMA_SUB_MODEL_ID)
    : true;

  const legs: ProviderLeg[] = [];
  const results: ChainResult[] = [];
  try {
    for (const providerName of args.providers) {
      const leg = await setUpProviderLeg(providerName);
      legs.push(leg);
      if (!leg.available) {
        console.log(`[${leg.name}] leg unavailable: ${leg.reason}`);
        for (const chain of chains) {
          results.push(notExecutedResult(chain, leg.name, leg.reason ?? ''));
        }
        continue;
      }
      console.log(`[${leg.name}] leg ready (${leg.modelId})`);

      // Once the Claude leg proves persistently rate-limited, hammering the
      // remaining chains would only burn quota — latch and record.
      let rateLimitLatch: string | undefined;
      for (const chain of chains) {
        if (rateLimitLatch !== undefined) {
          results.push(notExecutedResult(chain, leg.name, rateLimitLatch));
          continue;
        }
        if (chain.requiresMcp && mcpClient === undefined) {
          results.push(
            notExecutedResult(
              chain,
              leg.name,
              `mcp-x unavailable: ${mcpUnavailableReason ?? 'unknown'}`,
            ),
          );
          continue;
        }
        if (chain.requiresOllamaSubLeg && !ollamaSubLegUp) {
          results.push(
            notExecutedResult(
              chain,
              leg.name,
              `sub-leg infra missing: Ollama/${OLLAMA_SUB_MODEL_ID} unavailable`,
            ),
          );
          continue;
        }

        const deps: ChainDependencies = { mcpClient };
        const result = await runChainWithRetry(
          chain,
          leg.name,
          leg.model!,
          deps,
          {
            maxRetries: 2,
            backoffMs: 20_000,
          },
        );
        results.push(result);
        console.log(
          `[${leg.name}] ${chain.id}: ${cellStatus(result)} ` +
            `(tools=[${result.actualToolSequence.join(' -> ')}], ${result.latencyMs}ms` +
            `${result.error !== undefined ? `, error=${result.error.slice(0, 200)}` : ''})`,
        );
        if (
          result.notExecutedReason !== undefined &&
          result.error !== undefined &&
          isRateLimitError(result.error)
        ) {
          rateLimitLatch = result.notExecutedReason;
        }
      }
    }
  } finally {
    await mcpClient?.close();
    for (const leg of legs) await leg.cleanup?.();
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    flags: args,
    providerLegs: legs.map(({ name, available, reason, modelId }) => ({
      name,
      available,
      reason,
      modelId,
    })),
    results,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\nResults written to ${RESULTS_PATH}`);
  console.log('\n── Summary (chain x provider) ──');
  console.log(formatSummaryTable(chains, args.providers, results));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('A7 benchmark failed:', errorMessage(error));
    process.exitCode = 1;
  });
}
