/**
 * Native Claude CLI subprocess transport pool (LIA-449 walking skeleton).
 *
 * Design
 * - **Object Pool + Factory**: `ClaudeCliSessionPool` is the sole factory for
 *   its internal session state — the session type is not exported at all
 *   (module-private), so every caller goes through the pool's `maxProcesses`
 *   accounting. Bounded object pool (max size = `maxProcesses`): acquiring
 *   past the bound is a rejection (`concurrency_rejected`), never silent
 *   queuing or eviction.
 * - **Observer**: lifecycle events (`spawned`, `turn_started`,
 *   `turn_completed`, `concurrency_rejected`, `termination_requested`,
 *   `idle_reaped`, `unexpected_exit`, `exited`, `cleanup_complete`) are
 *   pushed through a single typed `onEvent` callback per pool instance.
 * - **Complexity**: concurrency accounting is an O(1) counter increment/
 *   decrement per spawn/exit — never a linear scan of live sessions.
 *
 * Isolation: this module is NOT imported by `deus-native-model.ts`,
 * `deus-native-backend.ts`, `nested-dispatch(-tool).ts`, or the runtime
 * registry. See `docs/decisions/deus-native-cli-subprocess-mcp-seam.md`.
 *
 * Platform scope: POSIX (macOS/Linux) only for this walking skeleton — the
 * detached-process-group spawn and its group-signal cleanup are POSIX
 * semantics. `killProcess`/`forceKillProcessGroup`/`processExists` are
 * reused unmodified from `src/platform.ts` rather than reimplemented, so a
 * future Windows pass only needs to fill in that file's existing
 * `taskkill /T` branch, not touch this module.
 */

import { createRequire } from 'node:module';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  killProcess,
  forceKillProcessGroup,
  processExists,
} from '../../platform.js';
import {
  BoundedEventLog,
  StreamJsonLineParser,
  buildUserTurnInput,
  encodeNdjsonLine,
  isResultEvent,
  type ParsedLineResult,
  type ResultEvent,
  type StreamJsonEvent,
} from './stream-json-protocol.js';

// ── Environment handling ──────────────────────────────

/**
 * Env vars that would silently reroute the CLI off its intended OAuth
 * subscription path. Their presence must fail the spike visibly rather than
 * let an ambiguous auth configuration be misreported as OAuth evidence.
 */
const AMBIGUOUS_AUTH_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

export function assertNoAmbiguousAuthOverride(env: NodeJS.ProcessEnv): void {
  const present = AMBIGUOUS_AUTH_ENV_VARS.filter(
    (name) => env[name] !== undefined && env[name] !== '',
  );
  if (present.length > 0) {
    throw new Error(
      `refusing to spawn the CLI subprocess: ${present.join(', ')} ` +
        `${present.length === 1 ? 'is' : 'are'} set, which would override ` +
        `the intended CLI OAuth route -- this walking skeleton must never ` +
        `silently claim OAuth evidence under an ambiguous auth configuration ` +
        ``,
    );
  }
}

/**
 * Clones the given env (defaults to `process.env`) and strips the two vars
 * that must never reach the child: `CLAUDECODE` (the nested-Claude recursion
 * guard, which would prevent this spike when launched from a Claude
 * development session) and `NODE_OPTIONS` (matches the published SDK
 * wrapper's protection against injecting loaders into the native CLI).
 * Everything else (`PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, proxy settings, ...)
 * is preserved so the CLI resolves its normal OAuth/config route.
 */
export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.CLAUDECODE;
  delete env.NODE_OPTIONS;
  return env;
}

// ── MCP scratch config ────

/**
 * Resolves `tsx`'s loader entry to an ABSOLUTE path, using the repo's own
 * module resolution (`repoRoot`), NOT the scratch working directory the CLI
 * subprocess runs from. `--import tsx` (a bare specifier) resolves via
 * standard node_modules resolution starting from the child's launch context;
 * since the scratch cwd deliberately lives outside the repo (for isolation),
 * that lookup can fail with `ERR_MODULE_NOT_FOUND` even though `tsx` is a
 * repo devDependency. This repo is `"type": "module"`, so plain `require`
 * isn't ambient — `createRequire` is the standard ESM idiom for it (same
 * technique already used in `packages/mcp-whatsapp/src/whatsapp.ts:27`).
 *
 * Verified directly against the installed `tsx` package.json `exports` map:
 * the `"."` export (bare `tsx` — the same target plain `--import tsx` uses)
 * resolves to `./dist/loader.mjs`, which performs the actual loader-
 * registration side effect. `"./esm/api"` is a DIFFERENT export resolving to
 * callable functions (`register`/`tsImport`), not a loader — using it here
 * would resolve successfully but register nothing, and the MCP child would
 * fail with `ERR_UNKNOWN_FILE_EXTENSION` on the `.ts` server file.
 */
export function resolveTsxLoaderPath(repoRoot: string): string {
  const requireFromHere = createRequire(import.meta.url);
  return requireFromHere.resolve('tsx', { paths: [repoRoot] });
}

export interface McpScratchConfigOptions {
  /** The key under `mcpServers` and the name asserted connected in `system/init`. */
  serverName: string;
  /** Absolute path to the standalone MCP server `.ts` entrypoint. */
  serverScriptPath: string;
  /** Repo root used ONLY to resolve the tsx loader — never the scratch cwd. */
  repoRoot: string;
  nodeExecPath?: string;
}

export interface McpScratchConfig {
  mcpServers: Record<
    string,
    { type: 'stdio'; command: string; args: string[] }
  >;
}

/**
 * Builds the ephemeral `--mcp-config` JSON content. An absolute
 * `--import <loaderPath>` path is resolved as a direct file reference by
 * Node regardless of cwd, sidestepping the bare-specifier resolution problem
 * entirely while still letting the scratch directory stay outside the repo.
 */
export function buildMcpScratchConfig(
  options: McpScratchConfigOptions,
): McpScratchConfig {
  const tsxLoaderPath = resolveTsxLoaderPath(options.repoRoot);
  return {
    mcpServers: {
      [options.serverName]: {
        type: 'stdio',
        command: options.nodeExecPath ?? process.execPath,
        args: ['--import', tsxLoaderPath, options.serverScriptPath],
      },
    },
  };
}

/** Writes the scratch MCP config to disk and returns its absolute path. */
export function writeMcpScratchConfig(
  scratchDir: string,
  config: McpScratchConfig,
  fileName = 'mcp-config.json',
): string {
  fs.mkdirSync(scratchDir, { recursive: true });
  const configPath = path.join(scratchDir, fileName);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ── CLI argument construction ─

export interface ClaudeCliArgsOptions {
  mcpConfigPath: string;
  allowedTool: string;
  permissionMode?: string;
}

/**
 * All flags verified directly against installed `claude --help` (2.1.214)
 * before relying on them (the committed ADR (`docs/decisions/deus-native-cli-subprocess-mcp-seam.md`) "CLI flag
 * verification"). `--print` is required for both stream-json formats;
 * persistence across turns comes from leaving stdin open after a `result`,
 * not from omitting `--print`.
 */
export function buildClaudeCliArgs(options: ClaudeCliArgsOptions): string[] {
  return [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    options.mcpConfigPath,
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--tools',
    '',
    '--allowedTools',
    options.allowedTool,
    '--permission-mode',
    options.permissionMode ?? 'dontAsk',
  ];
}

// ── Injectable process control (spawn + kill/exists) ────────────────────────

export interface WritableLike {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

/** The subset of `child_process.ChildProcess` this pool depends on. Kept
 *  narrow and structural (rather than importing `ChildProcess` directly) so
 *  unit tests can inject a fake without constructing a real process. */
export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: 'error', listener: (err: Error) => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
}

export interface SpawnOptionsLike {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdio: ['pipe', 'pipe', 'pipe'];
  detached: boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsLike,
) => ChildProcessLike;

/** Default, production `SpawnFn`: a thin cast over `child_process.spawn`.
 *  Structural interface + cast (rather than importing `ChildProcess`)
 *  because the fake used in unit tests only ever needs to satisfy
 *  `ChildProcessLike`, not the full Node type. */
export const nodeChildProcessSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as ChildProcessLike;

/**
 * `kill`/`forceKill`/`exists` are injectable ONLY so unit tests can drive a
 * fake process's "is it still alive" state without a real OS PID (a fake PID
 * probed with the real `process.kill(pid, 0)` from `src/platform.ts` would
 * always report "not alive", defeating any escalation test). Production
 * always uses `defaultProcessControlFns`, which is exactly
 * `killProcess`/`forceKillProcessGroup`/`processExists` reused unmodified
 * from `src/platform.ts` — never scattering raw platform-specific signal
 * logic.
 */
export interface ProcessControlFns {
  kill: (pid: number) => void;
  forceKill: (pid: number) => void;
  exists: (pid: number) => boolean;
}

export const defaultProcessControlFns: ProcessControlFns = {
  kill: killProcess,
  forceKill: forceKillProcessGroup,
  exists: processExists,
};

// ── Lifecycle events (Observer) ──────────────────────────────────────────────

export type SessionLifecycleEventType =
  | 'spawned'
  | 'turn_started'
  | 'turn_completed'
  | 'concurrency_rejected'
  | 'termination_requested'
  | 'idle_reaped'
  | 'unexpected_exit'
  | 'exited'
  | 'cleanup_complete';

export interface SessionLifecycleEvent {
  type: SessionLifecycleEventType;
  timestamp: number;
  conversationId?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  detail?: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ClaudeCliSessionErrorCode =
  | 'capacity_exceeded'
  | 'already_exists'
  | 'not_found'
  | 'busy'
  | 'spawn_error'
  | 'unexpected_exit'
  | 'protocol_error';

export class ClaudeCliSessionError extends Error {
  constructor(
    message: string,
    public readonly code: ClaudeCliSessionErrorCode,
    public readonly detail?: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string;
    },
  ) {
    super(message);
    this.name = 'ClaudeCliSessionError';
  }
}

// ── Public result/handle types ───────────────────────────────────────────────

export interface ConversationHandle {
  conversationId: string;
  pid: number;
}

export interface TurnResult {
  result: ResultEvent;
  /** All retained events for this session (bounded), including the
   *  session's own system/init, assistant tool-use, and user tool-result
   *  events collected since spawn — everything the smoke runner's
   *  assertions need, in one return value. */
  events: StreamJsonEvent[];
  pid: number;
}

export interface CreateConversationOptions {
  /** Isolated scratch working directory for this one conversation's process. */
  scratchDir: string;
  mcpServerName: string;
  mcpServerScriptPath: string;
  /** Repo root, used only to resolve the tsx loader (never the scratch cwd). */
  repoRoot: string;
  allowedTool: string;
  permissionMode?: string;
}

// ── Internal session record (module-private — no public constructor) ──────

type SessionState = 'idle' | 'busy';
type TerminationReason = 'idle' | 'shutdown';

interface PendingTurn {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
}

interface SessionRecord {
  conversationId: string;
  process: ChildProcessLike;
  pid: number;
  state: SessionState;
  lineParser: StreamJsonLineParser;
  retainedEvents: BoundedEventLog<StreamJsonEvent>;
  stderrTail: string;
  /** Per-stream UTF-8 decoders: `Buffer#toString('utf8')` on each chunk
   *  independently corrupts multi-byte characters split across a chunk
   *  boundary (produces replacement characters, which can then break JSON
   *  parsing and misreport a real turn as a `protocol_error`). `StringDecoder`
   *  buffers a trailing incomplete byte sequence until the next chunk
   *  completes it — one instance per stream, since its buffering state must
   *  persist across chunks for the SAME stream, never shared or reset. */
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  pendingTurn?: PendingTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  finalized: boolean;
  /** Resolves exactly once `finalizeSession` actually runs for this record
   *  (i.e. the real child process's own `'exit'`/`'error'` event fired).
   *  `terminateSession` awaits this directly instead of a fixed sleep, so it
   *  cannot report completion before the process is genuinely confirmed
   *  gone — a sleep-based grace period is used only to decide WHEN to
   *  escalate (SIGTERM -> SIGKILL), never as a substitute for the real
   *  exit confirmation. */
  finalizedPromise: Promise<void>;
  resolveFinalized: () => void;
  /** Set right before we deliberately tear a session down (idle-reap or
   *  shutdownAll), so `exited` finalization can tell "we asked for this"
   *  apart from a genuine crash (`unexpected_exit`). */
  terminationReason?: TerminationReason;
}

export interface ClaudeCliSessionPoolOptions {
  maxProcesses: number;
  idleTimeoutMs: number;
  terminationGraceMs: number;
  onEvent: (event: SessionLifecycleEvent) => void;
  spawnFn?: SpawnFn;
  claudeBin?: string;
  processControl?: ProcessControlFns;
  maxRetainedEvents?: number;
  maxStderrTailChars?: number;
  now?: () => number;
}

const DEFAULT_MAX_RETAINED_EVENTS = 200;
const DEFAULT_MAX_STDERR_TAIL_CHARS = 4000;

/**
 * The pool: sole factory for the (module-private, never-exported) session
 * state. See the module doc comment for the Object Pool + Factory + Observer
 * design rationale.
 */
export class ClaudeCliSessionPool {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly spawnFn: SpawnFn;
  private readonly claudeBin: string;
  private readonly processControl: ProcessControlFns;
  private readonly maxRetainedEvents: number;
  private readonly maxStderrTailChars: number;
  private readonly now: () => number;
  private occupiedSlotsCount = 0;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: ClaudeCliSessionPoolOptions) {
    this.spawnFn = options.spawnFn ?? nodeChildProcessSpawn;
    this.claudeBin = options.claudeBin ?? 'claude';
    this.processControl = options.processControl ?? defaultProcessControlFns;
    this.maxRetainedEvents =
      options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS;
    this.maxStderrTailChars =
      options.maxStderrTailChars ?? DEFAULT_MAX_STDERR_TAIL_CHARS;
    this.now = options.now ?? (() => Date.now());
  }

  get occupiedSlots(): number {
    return this.occupiedSlotsCount;
  }

  get activeConversationIds(): string[] {
    return [...this.sessions.keys()];
  }

  private emit(event: SessionLifecycleEvent): void {
    this.options.onEvent(event);
  }

  // ── Creation (Object Pool acquire) ─────────────────────────────────────

  async createConversation(
    conversationId: string,
    createOptions: CreateConversationOptions,
  ): Promise<ConversationHandle> {
    if (this.sessions.has(conversationId)) {
      throw new ClaudeCliSessionError(
        `conversation "${conversationId}" already exists`,
        'already_exists',
      );
    }
    if (this.occupiedSlotsCount >= this.options.maxProcesses) {
      this.emit({
        type: 'concurrency_rejected',
        conversationId,
        timestamp: this.now(),
      });
      throw new ClaudeCliSessionError(
        `capacity exceeded: maxProcesses=${this.options.maxProcesses}, ` +
          `occupiedSlots=${this.occupiedSlotsCount}`,
        'capacity_exceeded',
      );
    }

    const env = buildChildEnv();
    assertNoAmbiguousAuthOverride(env);
    const mcpConfig = buildMcpScratchConfig({
      serverName: createOptions.mcpServerName,
      serverScriptPath: createOptions.mcpServerScriptPath,
      repoRoot: createOptions.repoRoot,
    });
    const mcpConfigPath = writeMcpScratchConfig(
      createOptions.scratchDir,
      mcpConfig,
    );
    const args = buildClaudeCliArgs({
      mcpConfigPath,
      allowedTool: createOptions.allowedTool,
      permissionMode: createOptions.permissionMode,
    });

    const child = this.spawnFn(this.claudeBin, args, {
      env,
      cwd: createOptions.scratchDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own Unix process group: terminating the group (via
      // killProcess/forceKillProcessGroup's `process.kill(-pid, ...)`) also
      // reaps the stdio MCP grandchild it spawns.
      detached: true,
    });

    let resolveFinalized!: () => void;
    const finalizedPromise = new Promise<void>((resolve) => {
      resolveFinalized = resolve;
    });

    const record: SessionRecord = {
      conversationId,
      process: child,
      pid: child.pid ?? -1,
      state: 'idle',
      lineParser: new StreamJsonLineParser(),
      retainedEvents: new BoundedEventLog<StreamJsonEvent>(
        this.maxRetainedEvents,
      ),
      stderrTail: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      finalized: false,
      finalizedPromise,
      resolveFinalized,
    };
    this.sessions.set(conversationId, record);
    this.occupiedSlotsCount++;
    this.wireProcessHandlers(record);

    // Give an immediate spawn failure (e.g. ENOENT: no `claude` on PATH) one
    // tick to surface via the 'error' handler already wired above before
    // declaring success — `child_process.spawn`'s 'error' event is always
    // asynchronous, so one macrotask is sufficient.
    let immediateSpawnError: Error | undefined;
    const captureImmediateError = (err: Error): void => {
      immediateSpawnError = err;
    };
    child.once('error', captureImmediateError);
    await new Promise<void>((resolve) => setImmediate(resolve));

    if (record.finalized || immediateSpawnError !== undefined) {
      throw new ClaudeCliSessionError(
        `failed to spawn claude CLI for conversation "${conversationId}": ` +
          `${immediateSpawnError?.message ?? 'process exited immediately'}`,
        'spawn_error',
      );
    }

    this.emit({
      type: 'spawned',
      conversationId,
      pid: record.pid,
      timestamp: this.now(),
    });
    this.armIdleTimer(record);
    return { conversationId, pid: record.pid };
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  async sendTurn(conversationId: string, prompt: string): Promise<TurnResult> {
    const record = this.sessions.get(conversationId);
    if (record === undefined) {
      throw new ClaudeCliSessionError(
        `no such conversation "${conversationId}"`,
        'not_found',
      );
    }
    if (record.state === 'busy') {
      // Reject overlapping turns instead of interleaving two prompts on the
      // same process.
      throw new ClaudeCliSessionError(
        `conversation "${conversationId}" already has a turn in flight`,
        'busy',
      );
    }

    record.state = 'busy';
    this.clearIdleTimer(record); // paused while a turn is active
    this.emit({
      type: 'turn_started',
      conversationId,
      pid: record.pid,
      timestamp: this.now(),
    });

    return new Promise<TurnResult>((resolve, reject) => {
      record.pendingTurn = { resolve, reject };
      const line = encodeNdjsonLine(buildUserTurnInput(prompt));
      record.process.stdin?.write(line);
    });
  }

  getEvents(conversationId: string): StreamJsonEvent[] {
    return this.sessions.get(conversationId)?.retainedEvents.toArray() ?? [];
  }

  getStderrTail(conversationId: string): string {
    return this.sessions.get(conversationId)?.stderrTail ?? '';
  }

  getPid(conversationId: string): number | undefined {
    return this.sessions.get(conversationId)?.pid;
  }

  // ── Stream wiring ────────────────────────────────────────────────────────

  private wireProcessHandlers(record: SessionRecord): void {
    record.process.stdout?.on('data', (chunk) =>
      this.handleStdoutChunk(record, chunk),
    );
    record.process.stderr?.on('data', (chunk) =>
      this.handleStderrChunk(record, chunk),
    );
    // EPIPE etc. if the child already exited — same swallow-and-log posture
    // as the existing container-runner.ts stdin 'error' handler (LIA-385):
    // an unhandled stream 'error' would otherwise crash the host process.
    record.process.stdin?.on('error', () => {
      /* the 'exit'/'error' handlers below already resolve the session's
       * true status; a stdin write racing an already-exited child is not
       * itself a new failure to report. */
    });
    record.process.on('error', (err: Error) => {
      this.finalizeSession(record, null, null, err);
    });
    record.process.on('exit', (code, signal) => {
      this.finalizeSession(record, code, signal);
    });
  }

  private handleStdoutChunk(
    record: SessionRecord,
    chunk: Buffer | string,
  ): void {
    const text =
      typeof chunk === 'string' ? chunk : record.stdoutDecoder.write(chunk);
    for (const result of record.lineParser.push(text)) {
      this.handleParsedLine(record, result);
    }
  }

  private handleStderrChunk(
    record: SessionRecord,
    chunk: Buffer | string,
  ): void {
    const text =
      typeof chunk === 'string' ? chunk : record.stderrDecoder.write(chunk);
    // A true rolling TAIL (keep the most recent N chars), not a
    // stop-once-truncated accumulator: the chars right before a crash are
    // the diagnostically useful ones. Stderr activity never resets the idle
    // timer.
    record.stderrTail = (record.stderrTail + text).slice(
      -this.maxStderrTailChars,
    );
  }

  private handleParsedLine(
    record: SessionRecord,
    result: ParsedLineResult,
  ): void {
    if (result.kind === 'malformed' || result.kind === 'overflow') {
      // Surfaced as a protocol failure, never silently dropped: retained for
      // inspection AND, if a turn is in flight, fails that turn immediately
      // rather than waiting forever for a 'result' event that may never come.
      record.retainedEvents.push({
        type: '_protocol_error',
        kind: result.kind,
        raw: result.raw,
        error: result.error,
      });
      this.failPendingTurn(
        record,
        new ClaudeCliSessionError(
          `protocol failure on conversation "${record.conversationId}": ${result.error}`,
          'protocol_error',
          { stderrTail: record.stderrTail },
        ),
      );
      return;
    }

    const event = result.event as StreamJsonEvent;
    record.retainedEvents.push(event);
    if (isResultEvent(event) && record.pendingTurn !== undefined) {
      const pending = record.pendingTurn;
      record.pendingTurn = undefined;
      record.state = 'idle';
      this.armIdleTimer(record);
      this.emit({
        type: 'turn_completed',
        conversationId: record.conversationId,
        pid: record.pid,
        timestamp: this.now(),
      });
      pending.resolve({
        result: event,
        events: record.retainedEvents.toArray(),
        pid: record.pid,
      });
    }
  }

  private failPendingTurn(record: SessionRecord, error: Error): void {
    if (record.pendingTurn === undefined) return;
    const pending = record.pendingTurn;
    record.pendingTurn = undefined;
    record.state = 'idle';
    this.armIdleTimer(record);
    pending.reject(error);
  }

  // ── Idle reap ────────────────────────────────────────────────────────────

  private armIdleTimer(record: SessionRecord): void {
    this.clearIdleTimer(record);
    if (record.finalized) return;
    record.idleTimer = setTimeout(
      () => void this.handleIdleTimeout(record),
      this.options.idleTimeoutMs,
    );
    record.idleTimer.unref();
  }

  private clearIdleTimer(record: SessionRecord): void {
    if (record.idleTimer !== undefined) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
  }

  private async handleIdleTimeout(record: SessionRecord): Promise<void> {
    if (record.finalized || record.state === 'busy') return;
    record.terminationReason = 'idle';
    this.emit({
      type: 'idle_reaped',
      conversationId: record.conversationId,
      pid: record.pid,
      timestamp: this.now(),
    });
    await this.terminateSession(record);
  }

  // ── Termination sequence (idle-reap and shutdownAll share this) ─────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Races `record.finalizedPromise` against a grace-period timeout, purely
   *  to decide WHEN to escalate (SIGTERM -> SIGKILL) -- never used as a
   *  substitute for the real exit confirmation. Clears its own timer either
   *  way so a resolved-early race doesn't leak a pending timer. */
  private async waitForFinalizedOrTimeout(
    record: SessionRecord,
    ms: number,
  ): Promise<'finalized' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const outcome = await Promise.race([
      record.finalizedPromise.then((): 'finalized' => 'finalized'),
      timeout,
    ]);
    clearTimeout(timer!);
    return outcome;
  }

  /** Close stdin, wait a grace period, SIGTERM the process group, wait
   *  again, SIGKILL-escalate if it's still alive -- then UNCONDITIONALLY
   *  await the real `finalizedPromise` before returning. The grace-period
   *  races above only decide escalation timing; sending a kill signal is
   *  fire-and-forget (the OS reaps the process and Node's 'exit' event
   *  fires asynchronously, not synchronously with the signal), so without
   *  this final unconditional await, `shutdownAll()`/`terminateSession()`
   *  could resolve and report `cleanup_complete` before the process is
   *  genuinely confirmed dead -- exactly the gap a fake test that fires
   *  'exit' synchronously inside its kill/forceKill mock cannot expose. */
  private async terminateSession(record: SessionRecord): Promise<void> {
    try {
      record.process.stdin?.end();
    } catch {
      /* already closed */
    }

    if (
      (await this.waitForFinalizedOrTimeout(
        record,
        this.options.terminationGraceMs,
      )) !== 'finalized' &&
      record.pid >= 0 &&
      this.processControl.exists(record.pid)
    ) {
      this.processControl.kill(record.pid);
      if (
        (await this.waitForFinalizedOrTimeout(
          record,
          this.options.terminationGraceMs,
        )) !== 'finalized' &&
        record.pid >= 0 &&
        this.processControl.exists(record.pid)
      ) {
        this.processControl.forceKill(record.pid);
      }
    }

    await record.finalizedPromise;
  }

  /** Single idempotent finalization path: releases
   *  the concurrency slot exactly once, regardless of how many times
   *  'error'/'exit' fire or in what order. */
  private finalizeSession(
    record: SessionRecord,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (record.finalized) return;
    record.finalized = true;
    record.resolveFinalized();
    this.clearIdleTimer(record);
    this.occupiedSlotsCount = Math.max(0, this.occupiedSlotsCount - 1);
    this.sessions.delete(record.conversationId);
    for (const flushed of record.lineParser.flush()) {
      this.handleParsedLine(record, flushed);
    }

    this.failPendingTurn(
      record,
      new ClaudeCliSessionError(
        `session for conversation "${record.conversationId}" exited ` +
          `unexpectedly mid-turn`,
        'unexpected_exit',
        { exitCode, signal, stderrTail: record.stderrTail },
      ),
    );

    if (record.terminationReason === undefined) {
      // Nobody asked for this exit (no idle-reap, no shutdownAll) -- a crash.
      this.emit({
        type: 'unexpected_exit',
        conversationId: record.conversationId,
        pid: record.pid,
        exitCode,
        signal,
        detail: error?.message ?? record.stderrTail.slice(-500),
        timestamp: this.now(),
      });
    }
    this.emit({
      type: 'exited',
      conversationId: record.conversationId,
      pid: record.pid,
      exitCode,
      signal,
      timestamp: this.now(),
    });
  }

  // ── Parent cleanup ──────────────────────────────

  /** Idempotent, graceful shutdown of every live session. Repeated calls
   *  return the same (possibly already-settled) promise. */
  async shutdownAll(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      const records = [...this.sessions.values()];
      for (const record of records) {
        if (record.finalized) continue;
        record.terminationReason = 'shutdown';
        this.emit({
          type: 'termination_requested',
          conversationId: record.conversationId,
          pid: record.pid,
          timestamp: this.now(),
        });
      }
      await Promise.all(records.map((record) => this.terminateSession(record)));
      this.emit({ type: 'cleanup_complete', timestamp: this.now() });
    })();
    return this.shutdownPromise;
  }

  /** Best-effort SYNCHRONOUS teardown for the process `'exit'` event, which
   *  cannot await a promise. Sends a direct SIGKILL-to-group to every still-
   *  live session; does not wait to confirm and does not emit lifecycle
   *  events (the host process is exiting this same tick regardless). */
  shutdownAllSync(): void {
    for (const record of this.sessions.values()) {
      if (record.finalized) continue;
      if (record.pid >= 0) {
        try {
          this.processControl.forceKill(record.pid);
        } catch {
          /* best effort */
        }
      }
    }
  }
}
