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
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  is_error?: boolean;
}

export interface AssistantEvent extends StreamJsonEventBase {
  type: 'assistant';
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: 'assistant';
    content: ContentBlockBase[];
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

/**
 * The CLI's terminal `result` event — one per turn, always the last event of
 * a successful or failed turn. `is_error`/`subtype` distinguish success from
 * failure; `result` carries the final text on success.
 */
export interface ResultEvent extends StreamJsonEventBase {
  type: 'result';
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
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

/** Flattens a tool_result block's own `content` array to plain text, for
 *  assertions that need to inspect what the tool actually returned. */
export function extractToolResultText(block: ToolResultContentBlock): string {
  if (block.content === undefined) return '';
  return block.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
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
