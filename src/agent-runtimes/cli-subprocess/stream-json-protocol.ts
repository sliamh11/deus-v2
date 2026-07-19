/**
 * stream-json wire protocol for the native Claude CLI subprocess transport
 * (LIA-449 walking skeleton).
 *
 * PURE parsing/typing only — no I/O, no process, no clock. Mirrors the shape
 * `container/agent-runner/src/index.ts`'s `MessageStream` already sends over
 * the SDK transport (`SDKUserMessage`) and the raw event shapes verified
 * directly against the installed CLI (2.1.214, `claude --print
 * --input-format stream-json --output-format stream-json --verbose`) before
 * writing this module — see the walking-skeleton smoke script for the live
 * proof. This module only narrows/frames; it never talks to a subprocess
 * (that is `claude-cli-session-pool.ts`'s job).
 *
 * Isolation: this directory (`src/agent-runtimes/cli-subprocess/`) is a new,
 * unregistered module — no barrel export, not imported by
 * `deus-native-model.ts`/`deus-native-backend.ts`/the runtime registry/
 * nested dispatch. See the ADR (`docs/decisions/deus-native-cli-subprocess-mcp-seam.md`).
 */

// ── Input envelope ──────────────────────────────────────────────────────────

/**
 * One newline-terminated JSON turn sent on the CLI's stdin under
 * `--input-format stream-json`. Matches the existing container runner's
 * `SDKUserMessage` shape byte-for-byte (`container/agent-runner/src/index.ts`
 * `MessageStream.push`), so the same envelope already proven against the SDK
 * transport is reused here rather than inventing a parallel one.
 */
export interface StreamJsonUserTurnInput {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export function buildUserTurnInput(prompt: string): StreamJsonUserTurnInput {
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/** Encodes one turn as the single NDJSON line written to stdin. */
export function encodeNdjsonLine(input: StreamJsonUserTurnInput): string {
  return JSON.stringify(input) + '\n';
}

// ── Output events ────────────────────────────────────────────────────────────

/**
 * Loosely-typed base for every parsed stdout line. The CLI's stream-json
 * output carries many event `type`s (`system`, `assistant`, `user`, `result`,
 * `rate_limit_event`, ...) and each `type` has fields that vary by CLI
 * version; narrowing helpers below cover only what this walking skeleton
 * consumes (system/init, assistant, user, terminal result) rather than
 * modeling the full schema, matching this walking skeleton's scope.
 */
export interface StreamJsonEventBase {
  type: string;
  [key: string]: unknown;
}

export type StreamJsonEvent = StreamJsonEventBase;

/** A `system` event reporting one configured MCP server's connection state. */
export interface McpServerStatus {
  name: string;
  status: string;
}

/**
 * The CLI's `system`/`init` event. Verified fields (2.1.214 live output):
 * `session_id`, `mcp_servers` (empty array when no `--mcp-config` connects,
 * one entry with `status: "connected"`/`"failed"` per configured server),
 * `tools` (the resolved allowed tool-name list).
 */
export interface SystemInitEvent extends StreamJsonEventBase {
  type: 'system';
  subtype: 'init';
  session_id: string;
  mcp_servers: McpServerStatus[];
  tools: string[];
}

export function isSystemInitEvent(
  event: StreamJsonEventBase,
): event is SystemInitEvent {
  return (
    event.type === 'system' &&
    event['subtype'] === 'init' &&
    Array.isArray(event['mcp_servers'])
  );
}

/** One content block inside an `assistant`/`user` message. Verified variants:
 *  `text`, `thinking`, `tool_use` (assistant); `tool_result` (user). */
export interface ContentBlockBase {
  type: string;
  [key: string]: unknown;
}

export interface TextContentBlock extends ContentBlockBase {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock extends ContentBlockBase {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock extends ContentBlockBase {
  type: 'tool_result';
  tool_use_id: string;
  // The real `claude` CLI represents `content` as a plain string for an
  // `isError: true` MCP tool result (confirmed live, LIA-454 §3.1 spike,
  // `lia449b_mcp_deny_equivalence_spike.ts`) — the array-of-parts shape
  // below is what a normal (non-error) result uses. `extractToolResultText`
  // must handle both.
  content?:
    string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
}

/**
 * One assistant model cycle's usage. `input_tokens` is the NEW (non-cached)
 * prompt tokens only — cache hits/writes are separate, additive counters,
 * never folded into it by the CLI itself. Cost/model-usage/permission-denial
 * fields only ever appear on the terminal `ResultEvent`, never here.
 */
export interface CliUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
  inference_geo?: string;
  [key: string]: unknown;
}

export interface AssistantEvent extends StreamJsonEventBase {
  type: 'assistant';
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: 'assistant';
    /** A stable per-cycle message id (`msg_...`), present on every real
     *  assistant event observed. */
    id?: string;
    /** The exact resolved model id string (e.g. `"claude-sonnet-5"`). */
    model?: string;
    content: ContentBlockBase[];
    usage?: CliUsage;
    [key: string]: unknown;
  };
}

export function isAssistantEvent(
  event: StreamJsonEventBase,
): event is AssistantEvent {
  return (
    event.type === 'assistant' &&
    typeof event['message'] === 'object' &&
    event['message'] !== null &&
    Array.isArray((event['message'] as { content?: unknown }).content)
  );
}

export interface UserEvent extends StreamJsonEventBase {
  type: 'user';
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: 'user';
    content: ContentBlockBase[];
    [key: string]: unknown;
  };
}

export function isUserEvent(event: StreamJsonEventBase): event is UserEvent {
  return (
    event.type === 'user' &&
    typeof event['message'] === 'object' &&
    event['message'] !== null &&
    Array.isArray((event['message'] as { content?: unknown }).content)
  );
}

/** Per-model breakdown on the terminal result event's `modelUsage` map —
 *  one entry per model id actually used this turn. */
export interface CliModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}

/**
 * The CLI's terminal `result` event — one per turn, always the last event of
 * a successful or failed turn. `is_error`/`subtype` distinguish success from
 * failure; `result` carries the final text on success. No `rate_limit_event`
 * has been captured live yet, so this type deliberately does not model that
 * shape — narrowing it requires a real captured 429, not an assumption.
 */
export interface ResultEvent extends StreamJsonEventBase {
  type: 'result';
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  /** Time-to-first-token, from spawn/turn-start — more precise than
   *  host-side wall-clock timing for the actual model round trip. */
  ttft_ms?: number;
  ttft_stream_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: CliUsage & {
    server_tool_use?: {
      web_search_requests?: number;
      web_fetch_requests?: number;
    };
    iterations?: Array<Record<string, unknown>>;
    speed?: string;
  };
  modelUsage?: Record<string, CliModelUsage>;
  /** Verified live as an empty array on an allowed turn; the denied-tool
   *  shape was verified separately by LIA-454's own §3.1 spike
   *  (`lia449b_mcp_deny_equivalence_spike.ts`), not re-captured here. */
  permission_denials?: unknown[];
  terminal_reason?: string;
}

export function isResultEvent(
  event: StreamJsonEventBase,
): event is ResultEvent {
  return (
    event.type === 'result' &&
    typeof event['is_error'] === 'boolean' &&
    typeof event['subtype'] === 'string'
  );
}

// ── Extraction helpers ───────────────────────────────────────────────────────

export function extractToolUseBlocks(
  event: AssistantEvent,
): ToolUseContentBlock[] {
  return event.message.content.filter(
    (block): block is ToolUseContentBlock => block.type === 'tool_use',
  );
}

export function extractToolResultBlocks(
  event: UserEvent,
): ToolResultContentBlock[] {
  return event.message.content.filter(
    (block): block is ToolResultContentBlock => block.type === 'tool_result',
  );
}

export function extractAssistantText(event: AssistantEvent): string {
  return event.message.content
    .filter((block): block is TextContentBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Flattens a tool_result block's `content` to plain text, for assertions
 *  that need to inspect what the tool actually returned. Handles both
 *  observed wire shapes: an array of content parts (normal result) and a
 *  plain string (observed for `isError: true` results — see the type
 *  comment on `ToolResultContentBlock.content`). */
export function extractToolResultText(block: ToolResultContentBlock): string {
  if (block.content === undefined) return '';
  if (typeof block.content === 'string') return block.content;
  return block.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

/** The stable per-cycle message id, when present. Never fabricated —
 *  `undefined` when the event carries none, matching this codebase's
 *  established "no fabricated zero/value" norm (`deus-native-usage.ts`). */
export function extractAssistantMessageId(
  event: AssistantEvent,
): string | undefined {
  return event.message.id;
}

/** The exact resolved model id string, when present. */
export function extractAssistantModel(
  event: AssistantEvent,
): string | undefined {
  return event.message.model;
}

export function extractAssistantUsage(
  event: AssistantEvent,
): CliUsage | undefined {
  return event.message.usage;
}

/**
 * Normalizes the CLI's usage shape into LangChain's `UsageMetadata` contract
 * (`@langchain/core/messages/metadata.js`). The CLI's own `input_tokens` is
 * the NEW (non-cached) prompt tokens only — cache reads/writes are separate,
 * additive counters (verified live: a 2-token `input_tokens` alongside a
 * 29,792-token `cache_creation_input_tokens` in the same real event) — so
 * LangChain's `input_tokens` ("Sum of all input token types") must be the
 * SUM of all three, with the breakdown preserved in `input_token_details`
 * rather than discarded. Returns `undefined` when no usage was reported at
 * all — never fabricates a zeroed usage object where none exists.
 */
export function normalizeCliUsageToLangChainUsage(usage: CliUsage): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
} {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheRead + cacheCreation;
  const outputTokens = usage.output_tokens;
  const hasCacheDetail =
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(hasCacheDetail
      ? {
          input_token_details: {
            ...(usage.cache_read_input_tokens !== undefined
              ? { cache_read: usage.cache_read_input_tokens }
              : {}),
            ...(usage.cache_creation_input_tokens !== undefined
              ? { cache_creation: usage.cache_creation_input_tokens }
              : {}),
          },
        }
      : {}),
  };
}

// ── Turn-sequence protocol validation ───────────────────────────────────────

export type TurnProtocolViolationKind =
  | 'orphan_tool_result'
  | 'duplicate_tool_use_id'
  | 'inconsistent_terminal_result';

export interface TurnProtocolViolation {
  kind: TurnProtocolViolationKind;
  detail: string;
}

/**
 * Validates a turn's exact event sequence for the three failure shapes step
 * 3 requires surfacing explicitly rather than silently ingesting: a
 * tool_result with no matching prior tool_use in the SAME turn, a duplicate
 * tool_use id within the same turn (both are checkpoint-corruption risks —
 * `checkpoint-translation.ts`'s message-ID/tool-call-ID pairing depends on
 * this being a real 1:1 relationship), and a terminal result whose
 * success/failure state disagrees with its own `result` text field. Returns
 * an empty array when the sequence is clean — never throws; callers decide
 * whether a violation fails the turn.
 */
export function validateTurnEventSequence(
  events: StreamJsonEvent[],
): TurnProtocolViolation[] {
  const violations: TurnProtocolViolation[] = [];
  const seenToolUseIds = new Set<string>();

  for (const event of events) {
    if (isAssistantEvent(event)) {
      for (const block of extractToolUseBlocks(event)) {
        if (seenToolUseIds.has(block.id)) {
          violations.push({
            kind: 'duplicate_tool_use_id',
            detail: `tool_use id "${block.id}" appears more than once in this turn`,
          });
        }
        seenToolUseIds.add(block.id);
      }
    }
    if (isUserEvent(event)) {
      for (const block of extractToolResultBlocks(event)) {
        if (!seenToolUseIds.has(block.tool_use_id)) {
          violations.push({
            kind: 'orphan_tool_result',
            detail: `tool_result references tool_use id "${block.tool_use_id}", which was never emitted this turn`,
          });
        }
      }
    }
    if (isResultEvent(event)) {
      // UNCONFIRMED ASSUMPTION (code-review flagged this, EP-002 step 3):
      // every real success terminal event captured so far (EP-002 step 2.3's
      // spike) carried non-empty `result` text. It is NOT yet verified that
      // every legitimate success subtype/shape always does — e.g. a turn
      // ending purely on tool calls with no trailing assistant text, if that
      // is even possible for this CLI. If a real captured counter-example
      // ever surfaces (step 4's checkpoint-bridge integration is the next
      // place this gets exercised against real turns), narrow this check
      // rather than removing it outright — the underlying risk (a corrupt/
      // truncated terminal event silently treated as success) is real.
      if (!event.is_error && event.result === undefined) {
        violations.push({
          kind: 'inconsistent_terminal_result',
          detail:
            'terminal result reports is_error:false but carries no result text',
        });
      }
    }
  }

  return violations;
}

// ── NDJSON incremental line parsing (bounded) ───────────────────────────────

export const DEFAULT_MAX_BUFFERED_CHARS = 1_000_000;

export type ParsedLineKind = 'event' | 'malformed' | 'overflow';

export interface ParsedLineResult {
  kind: ParsedLineKind;
  /** The raw line (bounded preview only for 'overflow', full text otherwise). */
  raw: string;
  event?: StreamJsonEvent;
  /** Present for 'malformed' and 'overflow'. */
  error?: string;
}

/**
 * Incremental NDJSON line splitter with a bounded partial-line buffer.
 *
 * Design note (bounded-accumulator pattern, matching `boundParseBuffer` in
 * `src/container-runner.ts:362`, the repo's existing precedent for capping a
 * streaming parse buffer rather than letting it grow for a child process's
 * full lifetime): a non-empty malformed line is surfaced via `kind:
 * 'malformed'`, never silently dropped. If the accumulated partial-line remainder (no newline seen yet)
 * exceeds `maxBufferedChars`, the buffer is cleared and a `kind: 'overflow'`
 * result is surfaced instead of growing unboundedly — the CLI child's own
 * lifetime is otherwise unbounded, so an un-terminated or pathologically long
 * line must not grow host memory forever.
 */
export class StreamJsonLineParser {
  private buffer = '';

  constructor(
    private readonly maxBufferedChars: number = DEFAULT_MAX_BUFFERED_CHARS,
  ) {}

  /** Feed one arbitrary chunk (may split a line at any boundary). Returns
   *  every complete line's parse result found in this call, in order. */
  push(chunk: string): ParsedLineResult[] {
    this.buffer += chunk;
    const results: ParsedLineResult[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const parsed = this.parseLine(line);
      if (parsed !== undefined) results.push(parsed);
      newlineIndex = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxBufferedChars) {
      results.push({
        kind: 'overflow',
        raw: this.buffer.slice(0, 200),
        error:
          `partial NDJSON line exceeded ${this.maxBufferedChars} chars ` +
          `without a newline terminator; buffer cleared`,
      });
      this.buffer = '';
    }
    return results;
  }

  /** Flush any remaining partial buffer (e.g. the process closed stdout
   *  mid-line). A non-empty remainder is parsed/surfaced exactly like a
   *  terminated line, never silently dropped. */
  flush(): ParsedLineResult[] {
    if (this.buffer.length === 0) return [];
    const remaining = this.buffer;
    this.buffer = '';
    const parsed = this.parseLine(remaining);
    return parsed === undefined ? [] : [parsed];
  }

  /** Current partial-buffer size, for tests/diagnostics only. */
  get bufferedChars(): number {
    return this.buffer.length;
  }

  private parseLine(line: string): ParsedLineResult | undefined {
    if (line.trim().length === 0) return undefined;
    try {
      const event = JSON.parse(line) as StreamJsonEvent;
      return { kind: 'event', raw: line, event };
    } catch (error) {
      return {
        kind: 'malformed',
        raw: line,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ── Bounded evidence retention ───────────────────────────────────────────────

/**
 * A capped FIFO list: pushing past `maxItems` drops the oldest entry. Used by
 * `ClaudeCliSessionPool` to retain the system/init, assistant tool-use, user
 * tool-result, and lifecycle evidence the smoke runner inspects, without
 * retaining an unbounded event history for a long-lived process.
 */
export class BoundedEventLog<T> {
  private readonly items: T[] = [];

  constructor(private readonly maxItems: number) {
    if (maxItems < 1) {
      throw new Error('BoundedEventLog: maxItems must be >= 1');
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxItems) {
      this.items.shift();
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }
}
