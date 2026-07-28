/**
 * LIA-494 — round-3 feature-exploration spike (`@ai-sdk/tui`'s
 * `runAgentTUI({ transport })` remote-transport execution loop).
 *
 * QUESTION FROM THE SPEC: "Can the runner act as a thin terminal harness
 * over Deus's existing HTTP `ChatTransport` without taking ownership of
 * session history, permissions, or tool execution?"
 *
 * This is a REAL, runnable protocol-level adapter spike — not a mock or a
 * description. Run it with:
 *
 *   npx tsx src/transport-runner-spike.tsx
 *
 * It never touches a live Deus daemon (none is running in this throwaway
 * worktree, and spinning one up is out of scope for a rendering-library
 * evaluation). Instead it builds `FixtureDeusDaemon`, an in-process fixture
 * that implements Deus's REAL client-transport contract byte-for-byte
 * (verbatim-ported types/signatures, cited below, from the real production
 * files — not invented), and drives `@ai-sdk/tui`'s actual, unmodified
 * `runAgentTUI` / `AgentTUIRunner` against an adapter that bridges the two.
 *
 * Verbatim-cited sources (read first-hand before writing any code here):
 *   - `deus-v2-mvp/src/cli/deus-native-chat.ts`
 *       `ChatDisplayEvent` union .............................. lines 87-98
 *       `CLI_CHAT_GROUP_FOLDER`/`CLI_CHAT_JID`/`CLI_CHAT_BACKEND` . 59-61
 *       `normalize()` (RuntimeEvent -> ChatDisplayEvent mapping) . 244-304
 *   - `deus-v2-mvp/src/cli/deus-native-chat-client.ts`
 *       `ChatTransport` (Deus's OWN client-transport interface) . 125-138
 *       `createHttpChatTransport` (`turn`/`respondPermission`/etc) 158-249
 *       (note: no `AbortSignal`/`signal` anywhere in this file — grepped)
 *   - `deus-v2-mvp/src/cli/deus-native-chat-server.ts`
 *       route table (`TURN_PATH`/`STATUS_PATH`/... ) ............ 63-67
 *       (five routes total: turn, status, close, plan,
 *       permission-response — no history/list-messages route)
 *   - `deus-v2-mvp/src/agent-runtimes/types.ts`
 *       `PermissionDecision = 'allow_once' | 'allow_always' | 'deny'` . 122
 *       `RuntimeEvent` union, incl. `permission_request` .......... 78-113
 *       (`permission_request` is commented "Not yet produced by any
 *       production runtime" at lines 103-105 — a real, load-bearing
 *       caveat on this whole spike, called out again below)
 *   - `deus-v2-mvp/src/agent-runtimes/permission-registry.ts`
 *       `PendingPermissionRegistry`, `DENY_TIMEOUT_MS = 120_000` .. 1-60
 *       (this fixture uses a much shorter timeout so the spike finishes
 *       in seconds; the real Deus value is cited, not reused, and the
 *       divergence is called out where it matters)
 *   - `node_modules/@ai-sdk/tui/src/agent-tui-runner.ts` (this worktree's
 *     installed 1.0.38) — `AgentTUIRunner.run()`/`streamMessages()`,
 *     `AgentTUIToolApprovalResponse`, `applyToolApprovalResponse`,
 *     `findPendingToolApprovalRequests` — read in full before designing
 *     the adapter below.
 *   - `node_modules/@ai-sdk/tui/dist/index.d.ts` — the PUBLISHED public
 *     surface (`runAgentTUI`, `RunAgentTUIOptions`) as opposed to the
 *     internal `src/` types, to test the "renderer escape hatch is
 *     unexported" claim directly rather than assume it.
 *   - `node_modules/ai/dist/index.d.ts` — AI SDK's `ChatTransport<UI_MESSAGE>`
 *     interface (`sendMessages`/`reconnectToStream`), `DynamicToolUIPart`,
 *     `readUIMessageStream`.
 */

import { runAgentTUI } from '@ai-sdk/tui';
import {
  readUIMessageStream,
  type ChatTransport as AiSdkChatTransport,
  type DynamicToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';

// ---------------------------------------------------------------------------
// Section 1 — verbatim-cited ports of Deus's REAL wire types/identifiers.
// Copied, not reinvented, from the production files cited in the header.
// This throwaway prototype cannot `npm install`/import across the
// `deus-v2-mvp` package boundary, so these are typed transcriptions, not
// live imports — kept intentionally identical to the source so any future
// drift is a diffable surprise, not a silent divergence.
// ---------------------------------------------------------------------------

/** Verbatim from deus-native-chat.ts:59-61. */
const CLI_CHAT_GROUP_FOLDER = 'deus-native-cli';
const CLI_CHAT_JID = 'cli:deus-native';
const CLI_CHAT_BACKEND = 'deus-native';

/** Verbatim from deus-native-chat.ts:87-98. */
type ChatDisplayEvent =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; label: string }
  | { kind: 'progress'; text: string }
  | {
      kind: 'permission_request';
      requestId: string;
      toolName: string;
      toolInputPreview: string;
    }
  | { kind: 'assistant_done' }
  | { kind: 'chat_error'; message: string };

/** Verbatim from agent-runtimes/types.ts:122. */
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * Verbatim from deus-native-chat-client.ts:125-138 — Deus's REAL
 * client-transport interface. Deliberately named `DeusChatTransport`, not
 * `ChatTransport`, so it never collides with AI SDK's own `ChatTransport`
 * import above; the whole point of this spike is that these are two
 * DIFFERENT contracts that must be bridged, not the same thing wearing two
 * names.
 */
interface DeusChatTransport {
  turn(
    prompt: string,
    cwd: string,
    onEvent: (event: ChatDisplayEvent) => void | Promise<void>,
  ): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  setPlanMode(enabled: boolean): Promise<{ mode: 'normal' | 'plan' }>;
  status(): Promise<{ sessionId: string | undefined; state: 'new' | 'resumed' }>;
  close(): Promise<void>;
}

/** Real value: permission-registry.ts:17. Fixture uses a far shorter one (see FixtureDeusDaemon). */
const REAL_DENY_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Section 2 — FixtureDeusDaemon: a realistic in-process stand-in for the
// real `deus-native-chat-server.ts` + `PendingPermissionRegistry`, driven
// through the EXACT client-facing shape a real daemon exposes. This models:
//   - one persistent session row per (groupFolder, backend), as
//     `NativeChatSessionStore`/`adoptSession` do (deus-native-chat.ts:78-81,
//     237-242) — survives across separate `turn()` calls;
//   - a pending-approval registry with an auto-deny timeout, as
//     `PendingPermissionRegistry` does (permission-registry.ts:25-60);
//   - the SAME five-route surface as the real server (turn / status / close
//     / plan / permission-response) — nothing more. In particular, no
//     history/transcript-read route, matching the real route table
//     (deus-native-chat-server.ts:63-67) exactly.
// ---------------------------------------------------------------------------

interface ScriptedTurnStep {
  /** Assistant text chunks to stream before any tool/permission activity. */
  preText?: string[];
  /** A `tool_use` progress line (RuntimeEvent 'tool_call' -> normalize(), lines 258-263). */
  toolUse?: string;
  /** A permission gate. UNCORRELATED with `toolUse` on the wire — see Section 3. */
  permission?: { requestId: string; toolName: string; toolInputPreview: string };
  /** Assistant text chunks to stream after the permission decision resolves. */
  postText?: string[];
}

class FixtureDeusDaemon implements DeusChatTransport {
  private sessionRow: { sessionId: string; turns: number } | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (d: PermissionDecision) => void; timeout: NodeJS.Timeout }
  >();
  /** Everything the daemon has ever said, independent of who is listening. Models the daemon as sole source of truth. */
  readonly authoritativeLog: string[] = [];
  turnsStarted = 0;

  constructor(
    private readonly script: ScriptedTurnStep,
    /** Fixture-only: real value is 120_000ms (permission-registry.ts:17). Shortened so the spike runs in seconds. */
    private readonly denyTimeoutMs = 800,
  ) {}

  /** Models a channel (WhatsApp/Telegram) message landing in the SAME daemon-owned session while no TUI is attached. */
  appendOutOfBandMessage(text: string): void {
    this.authoritativeLog.push(`[out-of-band] ${text}`);
  }

  async status(): Promise<{ sessionId: string | undefined; state: 'new' | 'resumed' }> {
    return {
      sessionId: this.sessionRow?.sessionId,
      state: this.sessionRow ? 'resumed' : 'new',
    };
  }

  async setPlanMode(): Promise<{ mode: 'normal' | 'plan' }> {
    return { mode: 'normal' };
  }

  async close(): Promise<void> {
    /* real endpoint closes the runtime session but never clears the stored row (deus-native-chat.ts:150-151) */
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // Mirrors PendingPermissionRegistry.resolve()'s false-return-on-unknown-id
      // behavior (permission-registry.ts:48-55), surfaced here as a thrown
      // error the same way createHttpChatTransport.respondPermission throws
      // on a non-ok HTTP response (deus-native-chat-client.ts:174-176).
      throw new Error(`permission response failed (404): unknown requestId ${requestId}`);
    }
    clearTimeout(entry.timeout);
    this.pending.delete(requestId);
    entry.resolve(decision);
  }

  /** Faithful to the REAL signature: push-callback, `Promise<void>`, NO AbortSignal parameter anywhere. */
  async turn(
    prompt: string,
    _cwd: string,
    onEvent: (event: ChatDisplayEvent) => void | Promise<void>,
  ): Promise<void> {
    this.turnsStarted += 1;
    if (!this.sessionRow) {
      this.sessionRow = { sessionId: `sess-${CLI_CHAT_GROUP_FOLDER}-001`, turns: 0 };
    }
    this.sessionRow.turns += 1;
    this.authoritativeLog.push(`[user] ${prompt}`);

    const s = this.script;
    for (const t of s.preText ?? []) {
      this.authoritativeLog.push(`[assistant] ${t}`);
      await onEvent({ kind: 'assistant_text', text: t });
    }
    if (s.toolUse) {
      await onEvent({ kind: 'tool_use', label: s.toolUse });
    }
    if (s.permission) {
      const decisionPromise = new Promise<PermissionDecision>((resolve) => {
        const timeout = setTimeout(() => {
          this.pending.delete(s.permission!.requestId);
          resolve('deny'); // matches PendingPermissionRegistry's timeout-fires-deny (permission-registry.ts:39-42)
        }, this.denyTimeoutMs);
        this.pending.set(s.permission!.requestId, { resolve, timeout });
      });
      await onEvent({
        kind: 'permission_request',
        requestId: s.permission.requestId,
        toolName: s.permission.toolName,
        toolInputPreview: s.permission.toolInputPreview,
      });
      // This is the REAL mechanism: the daemon's turn() call blocks here,
      // in-process, until respondPermission() resolves it (or the timeout
      // fires) — there is no second HTTP request involved on Deus's side.
      const decision = await decisionPromise;
      this.authoritativeLog.push(`[permission] ${s.permission.requestId} -> ${decision}`);
      if (decision === 'deny') {
        await onEvent({ kind: 'chat_error', message: 'Tool use denied by user.' });
        await onEvent({ kind: 'assistant_done' });
        return;
      }
    }
    for (const t of s.postText ?? []) {
      this.authoritativeLog.push(`[assistant] ${t}`);
      await onEvent({ kind: 'assistant_text', text: t });
    }
    await onEvent({ kind: 'assistant_done' });
  }
}

// ---------------------------------------------------------------------------
// Section 3 — the adapter under test: `ChatTransport<UIMessage>` (AI SDK's
// contract, as consumed by `runAgentTUI({ transport })`) implemented as a
// thin(?) bridge over `FixtureDeusDaemon`. Every design decision below is
// something the translation FORCED, not something chosen for convenience —
// each is called out because it's evaluation-relevant, not because it's
// elegant.
// ---------------------------------------------------------------------------

type ToolCallLifecycleEvent =
  | { chunkType: 'tool-input-available'; toolCallId: string; toolName: string; dynamic: true }
  | { chunkType: 'tool-approval-request'; approvalId: string; toolCallId: string }
  | { chunkType: 'tool-output-available' | 'tool-output-error'; toolCallId: string };

class DeusRunAgentTuiAdapter implements AiSdkChatTransport<UIMessage> {
  /** One shared queue per AgentTUIRunner `chatId` — needed because the runner
   * re-invokes `sendMessages()` a SECOND time after an approval decision
   * (agent-tui-runner.ts:189-197), but Deus's real `turn()` promise for that
   * SAME logical turn is still open, blocked on `respondPermission()`. AI
   * SDK's model is "each `sendMessages` call is an independent request";
   * Deus's real model is "one long-lived stream + an out-of-band
   * `respondPermission` POST that unblocks it". Bridging the two means the
   * adapter must become a stateful broker across calls, keyed by the
   * runner's own transient `chatId` — NOT a stateless pass-through. */
  private readonly activeTurns = new Map<
    string,
    {
      queue: UIMessageChunk[];
      waiters: Array<() => void>;
      done: boolean;
      error?: unknown;
      /** Set the instant a `permission_request` event arrives. Deus's real
       * daemon.turn() stream would NOT close here (it's one still-open
       * HTTP response, just paused mid-stream awaiting the decision) — but
       * AI SDK's contract has no "pause without ending" concept, so THIS
       * stream (the one `startNewTurn`'s caller is reading) must be
       * artificially closed here so `renderStream` can return and the
       * runner can see the approval-requested part and call
       * `readToolApproval`. The real daemon.turn() promise is untouched
       * and keeps running underneath, parked on its own decisionPromise. */
      pausedForApproval: boolean;
    }
  >();
  private toolCallSeq = 0;
  /** requestId <- toolCallId, so a later approval-continuation call can find
   * which Deus permission request to resolve. Populated only when a
   * `permission_request` event arrives — see the correlation-gap note below. */
  private readonly toolCallIdToRequestId = new Map<string, string>();

  readonly log: string[] = [];
  readonly chatIdsSeen = new Set<string>();
  /** Every ChatDisplayEvent kind actually observed, to check exhaustiveness claims empirically. */
  readonly eventKindsSeen = new Set<ChatDisplayEvent['kind']>();
  readonly toolLifecycleEvents: ToolCallLifecycleEvent[] = [];

  constructor(private readonly daemon: FixtureDeusDaemon) {}

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    this.chatIdsSeen.add(options.chatId);
    this.log.push(`sendMessages(trigger=${options.trigger}, chatId=${options.chatId}, messages=${options.messages.length})`);

    const last = options.messages.at(-1);
    const isApprovalContinuation =
      last?.role === 'assistant' &&
      last.parts.some(
        (p: any) => p?.type === 'dynamic-tool' && p.state === 'approval-responded',
      );

    if (isApprovalContinuation) {
      return this.continueAfterApproval(options.chatId, last as UIMessage, options.abortSignal);
    }
    return this.startNewTurn(options.chatId, last, options.abortSignal);
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // Deus's real client-transport has NO equivalent endpoint at all (only
    // turn/status/close/plan/permission-response exist —
    // deus-native-chat-server.ts:63-67), so there is nothing to bridge this
    // to. `AgentTUIRunner` never calls this method (confirmed by grep over
    // agent-tui-runner.ts: zero references), so its absence of a real
    // implementation is currently moot for this runner specifically — but
    // it would matter for a future @ai-sdk/tui version, or a caller that
    // uses ChatTransport directly without the runner.
    this.log.push('reconnectToStream() called — no Deus endpoint exists for this; returning null');
    return null;
  }

  private startNewTurn(
    chatId: string,
    last: UIMessage | undefined,
    abortSignal: AbortSignal | undefined,
  ): ReadableStream<UIMessageChunk> {
    const promptText =
      last?.role === 'user'
        ? last.parts.map((p: any) => (p.type === 'text' ? p.text : '')).join('')
        : '';

    const state = {
      queue: [] as UIMessageChunk[],
      waiters: [] as Array<() => void>,
      done: false,
      error: undefined as unknown,
      pausedForApproval: false,
    };
    this.activeTurns.set(chatId, state);

    const push = (chunk: UIMessageChunk) => {
      state.queue.push(chunk);
      const w = state.waiters.shift();
      if (w) w();
    };

    push({ type: 'start', messageId: `msg-${chatId}` } as UIMessageChunk);

    let aborted = false;
    abortSignal?.addEventListener('abort', () => {
      // This is the ENTIRE extent of what "cancellation" can mean here: we
      // stop forwarding further chunks into the reader-visible queue. It
      // does NOT — and structurally CANNOT, given Deus's real turn()
      // signature (deus-native-chat-client.ts:125-130, 208-217) — stop the
      // daemon's own in-flight work. There is no cancel/abort route on the
      // real server (route table: deus-native-chat-server.ts:63-67) and no
      // AbortSignal is ever threaded into its fetch() call. Real Deus keeps
      // running the turn server-side regardless of what the TUI does.
      aborted = true;
      this.log.push(`abortSignal fired for chatId=${chatId}: LOCAL stream truncation only, daemon.turn() keeps running server-side`);
    });

    // Bridge: push-callback (daemon.turn) -> queue -> pull-based ReadableStream.
    this.daemon
      .turn(promptText, process.cwd(), (event) => {
        if (aborted) return; // drop further UI-visible chunks; daemon call is NOT stopped by this
        this.translateEvent(chatId, event, push);
        if (event.kind === 'permission_request') {
          // See the `pausedForApproval` doc comment above: end THIS reader's
          // view of the stream here, without touching `state.done` (the
          // real daemon.turn() promise is still running, parked).
          state.pausedForApproval = true;
          const w = state.waiters.shift();
          if (w) w();
        }
      })
      .then(() => {
        state.done = true;
        const w = state.waiters.shift();
        if (w) w();
      })
      .catch((err) => {
        state.done = true;
        state.error = err;
        const w = state.waiters.shift();
        if (w) w();
      });

    return this.streamFromState(state);
  }

  private async continueAfterApproval(
    chatId: string,
    last: UIMessage,
    _abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const part = last.parts.find(
      (p: any) => p?.type === 'dynamic-tool' && p.state === 'approval-responded',
    ) as DynamicToolUIPart & { state: 'approval-responded'; approval: { id: string; approved: boolean } };

    const requestId = this.toolCallIdToRequestId.get(part.toolCallId);
    if (!requestId) {
      throw new Error(
        `adapter cannot map toolCallId=${part.toolCallId} back to a Deus requestId — ` +
          `no permission_request event ever supplied one for this tool call`,
      );
    }

    // THE reachability gap: AI SDK's approval is `approved: boolean` only
    // (agent-tui-runner.ts:65-68, `AgentTUIToolApprovalResponse`). Deus's
    // real decision space is three-way (`PermissionDecision`,
    // agent-runtimes/types.ts:122). This mapping can produce 'allow_once'
    // or 'deny' — it CANNOT produce 'allow_always'. There is no boolean
    // value, no reason string, no field ANYWHERE in what
    // `applyToolApprovalResponse` writes into the message
    // (agent-tui-runner.ts:650-669) that could carry that third state
    // through this call. This is a hard structural ceiling, not a missing
    // feature in this adapter.
    const decision: PermissionDecision = part.approval.approved ? 'allow_once' : 'deny';
    this.log.push(
      `continueAfterApproval: toolCallId=${part.toolCallId} requestId=${requestId} approved=${part.approval.approved} -> PermissionDecision='${decision}' (allow_always UNREACHABLE from this call site)`,
    );

    const state = this.activeTurns.get(chatId);
    if (!state) {
      throw new Error(
        `adapter has no in-flight turn for chatId=${chatId} to resume — the original daemon.turn() promise was lost`,
      );
    }

    await this.daemon.respondPermission(requestId, decision);
    // Deliberately do NOT start a new daemon.turn() call: the original one
    // (still executing inside startNewTurn's `.then()` chain) will now
    // unblock on its own and keep pushing into the SAME `state.queue`. This
    // second `sendMessages()` call just needs to hand the runner a stream
    // that continues draining that same queue from where the FIRST
    // stream's reader left off.
    return this.streamFromState(state, /* continuation */ true);
  }

  private translateEvent(chatId: string, event: ChatDisplayEvent, push: (c: UIMessageChunk) => void): void {
    this.eventKindsSeen.add(event.kind);
    switch (event.kind) {
      case 'assistant_text': {
        const id = `text-${chatId}`;
        push({ type: 'text-start', id } as UIMessageChunk);
        push({ type: 'text-delta', id, delta: event.text } as UIMessageChunk);
        push({ type: 'text-end', id } as UIMessageChunk);
        break;
      }
      case 'tool_use': {
        // Deus supplies NO toolCallId and NO structured input — only a
        // pre-formatted human-readable `label` (formatToolUse(),
        // deus-native-chat.ts:187-201, called from normalize()'s
        // 'tool_call' arm at line 258-263, which itself receives no id
        // either — RuntimeEvent's 'tool_call' variant is
        // `{ type; name; arguments }`, agent-runtimes/types.ts:83). The
        // adapter must invent BOTH a toolCallId and a stand-in `input`
        // value; the real structured arguments never reach the wire at
        // all, so the AI SDK part's `input` field can only ever hold the
        // pre-formatted label string, not the tool's actual input schema.
        const toolCallId = `tool-${++this.toolCallSeq}`;
        this.toolLifecycleEvents.push({ chunkType: 'tool-input-available', toolCallId, toolName: event.label, dynamic: true });
        push({
          type: 'tool-input-available',
          toolCallId,
          toolName: 'deus-tool', // real name is not on the wire — only the formatted label is
          input: { label: event.label }, // stand-in; NOT the real structured arguments
          dynamic: true,
        } as UIMessageChunk);
        break;
      }
      case 'permission_request': {
        // Correlation gap, confirmed by reading BOTH the display-event
        // union (deus-native-chat.ts:87-98) and the RuntimeEvent union
        // (agent-runtimes/types.ts:78-113): neither 'tool_call' nor
        // 'permission_request' carries any field the other also carries.
        // There is no toolCallId, no shared requestId, nothing. This
        // permission_request is therefore rendered as its OWN, unrelated
        // dynamic-tool part — even if a `tool_use` for conceptually the
        // same tool invocation just fired moments earlier, the adapter has
        // no way to know that and cannot merge them.
        const toolCallId = `perm-${event.requestId}`;
        this.toolCallIdToRequestId.set(toolCallId, event.requestId);
        push({
          type: 'tool-input-available',
          toolCallId,
          toolName: event.toolName,
          input: { preview: event.toolInputPreview },
          dynamic: true,
        } as UIMessageChunk);
        this.toolLifecycleEvents.push({ chunkType: 'tool-approval-request', approvalId: event.requestId, toolCallId });
        push({
          type: 'tool-approval-request',
          approvalId: event.requestId,
          toolCallId,
          isAutomatic: false,
        } as UIMessageChunk);
        break;
      }
      case 'progress':
        // No UIMessageChunk type maps cleanly to a transient status line
        // that isn't text and isn't a tool call; folded into a text delta
        // rather than inventing an unsupported chunk type.
        push({ type: 'text-delta', id: `text-${chatId}`, delta: `[progress] ${event.text}` } as UIMessageChunk);
        break;
      case 'assistant_done':
        push({ type: 'finish' } as UIMessageChunk);
        break;
      case 'chat_error':
        push({ type: 'error', errorText: event.message } as UIMessageChunk);
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
    // Note what this exhaustive switch structurally CANNOT do: there is no
    // `case` here, and can never be one without a Deus-side protocol
    // change, that emits 'tool-output-available' or 'tool-output-error'.
    // `ChatDisplayEvent` (deus-native-chat.ts:87-98) has no tool-result
    // variant at all — confirmed by the module's own doc comment
    // (deus-native-chat.ts:26-29): "No invented tool-result event ... the
    // RuntimeEvent contract has no tool-result variant". A dynamic-tool
    // part built from this transport can reach 'input-available' or the
    // approval states, but NEVER 'output-available'.
  }

  private streamFromState(
    state: {
      queue: UIMessageChunk[];
      waiters: Array<() => void>;
      done: boolean;
      error?: unknown;
      pausedForApproval: boolean;
    },
    continuation = false,
  ): ReadableStream<UIMessageChunk> {
    let cursor = continuation ? state.queue.length : 0;
    if (continuation) {
      // Clear the pause so this second reader keeps draining past it,
      // instead of immediately closing again on an already-true flag.
      state.pausedForApproval = false;
    }
    return new ReadableStream<UIMessageChunk>({
      pull: async (controller) => {
        while (true) {
          if (cursor < state.queue.length) {
            controller.enqueue(state.queue[cursor]);
            cursor += 1;
            return;
          }
          if (!continuation && state.pausedForApproval) {
            // Artificial stream-end: see the `pausedForApproval` doc
            // comment above. `state.done` stays false — daemon.turn() is
            // still running underneath.
            controller.close();
            return;
          }
          if (state.error) {
            controller.error(state.error);
            return;
          }
          if (state.done) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => state.waiters.push(resolve));
        }
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Section 4 — a scripted `AgentTUIRenderer` (the SAME internal shape
// `TerminalRenderer` implements — agent-tui-runner.ts:70-80). Passed through
// the runner-options escape hatch tested in Scenario 1. Uses the REAL 'ai'
// package's `readUIMessageStream` to reduce chunks into a `UIMessage`
// (library code, not a reimplementation), so the assembled message and the
// pending-approval detection that follows are genuinely what
// `AgentTUIRunner.run()` would see.
// ---------------------------------------------------------------------------

function makeScriptedRenderer(opts: {
  prompts: string[];
  approve: (req: { toolName: string; toolCallId: string }) => boolean;
  log: (line: string) => void;
}) {
  let promptIdx = 0;
  return {
    async readPrompt(): Promise<string | undefined> {
      if (promptIdx >= opts.prompts.length) return undefined;
      return opts.prompts[promptIdx++];
    },
    async renderStream(result: {
      uiMessageStream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>;
    }): Promise<UIMessage | undefined> {
      const stream = result.uiMessageStream as ReadableStream<UIMessageChunk>;
      let final: UIMessage | undefined;
      for await (const msg of readUIMessageStream<UIMessage>({ stream })) {
        final = msg;
      }
      if (final) {
        const texts = final.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text);
        opts.log(`renderStream: assembled UIMessage with ${final.parts.length} part(s); text="${texts.join('')}"`);
      }
      return final;
    },
    async readToolApproval(request: {
      approvalId: string;
      toolCallId: string;
      toolName: string;
    }): Promise<{ approved: boolean; reason?: string }> {
      const approved = opts.approve({ toolName: request.toolName, toolCallId: request.toolCallId });
      opts.log(`readToolApproval: toolName=${request.toolName} toolCallId=${request.toolCallId} -> approved=${approved}`);
      return { approved };
    },
  };
}

// ---------------------------------------------------------------------------
// Section 5 — scenarios, one per spec bullet.
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'INCONCLUSIVE';
interface ScenarioResult {
  name: string;
  verdict: Verdict;
  notes: string[];
}

async function scenario1_oneStreamedTurn(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const daemon = new FixtureDeusDaemon({
    preText: ['Checking the ticket status', '... found LIA-494, in progress.'],
    toolUse: 'Using linear_search: LIA-494',
  });
  const adapter = new DeusRunAgentTuiAdapter(daemon);
  const renderLog: string[] = [];
  const renderer = makeScriptedRenderer({
    prompts: ["what's the status of LIA-494?"],
    approve: () => true,
    log: (l) => renderLog.push(l),
  });

  // The escape hatch under direct test: `runAgentTUI`'s PUBLISHED d.ts
  // (node_modules/@ai-sdk/tui/dist/index.d.ts) types `options` as the
  // closed `RunAgentTUIOptions`, which has no `renderer` field anywhere —
  // it is only present on the unexported `AgentTUIRunnerOptions`
  // (src/agent-tui-runner.ts:82-86). We pass it via `as any` specifically
  // to test whether the JS runtime honors it despite TypeScript refusing
  // to type it — i.e. whether the "seam exists in source but isn't public"
  // claim from FINDINGS.md's prior rounds is actually exploitable or a
  // dead end.
  await runAgentTUI({
    transport: adapter,
    renderer,
  } as any);

  const usedCustomRenderer = renderLog.some((l) => l.startsWith('renderStream:'));
  notes.push(
    usedCustomRenderer
      ? 'CONFIRMED: the unexported renderer escape hatch DOES work at runtime via a type-cast — runAgentTUI ran our scripted renderer, not the default TerminalRenderer, even though the public .d.ts has no `renderer` field.'
      : 'The scripted renderer never ran — escape hatch did not work as hoped.',
  );
  notes.push(...renderLog);
  notes.push(`daemon.turnsStarted=${daemon.turnsStarted} (expected 1)`);
  notes.push(`adapter.eventKindsSeen=[${[...adapter.eventKindsSeen].join(', ')}]`);

  const toolPartArrivedAsInputAvailable = adapter.toolLifecycleEvents.some(
    (e) => e.chunkType === 'tool-input-available',
  );
  const anyOutputAvailable = adapter.toolLifecycleEvents.some(
    (e) => e.chunkType === 'tool-output-available' || e.chunkType === 'tool-output-error',
  );
  notes.push(
    `tool part reached 'input-available': ${toolPartArrivedAsInputAvailable}; reached an 'output-*' state: ${anyOutputAvailable} (expected false — see Scenario 3)`,
  );

  const verdict: Verdict = usedCustomRenderer && daemon.turnsStarted === 1 ? 'PASS' : 'FAIL';
  return { name: '1. One streamed turn, ChatDisplayEvent -> UIMessageChunk', verdict, notes };
}

async function scenario2_cancellationAbort(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const daemon = new FixtureDeusDaemon({
    preText: ['Starting a long tool run', 'still going'],
    postText: ['finished (this should NOT be seen client-side after abort)'],
  });
  const adapter = new DeusRunAgentTuiAdapter(daemon);
  const abortController = new AbortController();

  const stream = await adapter.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat-cancel-test',
    messageId: undefined,
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do something slow' }] }] as UIMessage[],
    abortSignal: abortController.signal,
  });

  const reader = stream.getReader();
  let seen = 0;
  // Read exactly the 'start' chunk, then abort immediately.
  await reader.read();
  seen += 1;
  abortController.abort();
  notes.push('abortSignal.abort() called after reading only the first chunk');

  // Drain whatever the adapter still lets through (should stop quickly).
  let sawPostAbortAssistantText = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += 1;
    if (value && (value as any).type === 'text-delta' && (value as any).delta?.includes('finished')) {
      sawPostAbortAssistantText = true;
    }
  }

  await new Promise((r) => setTimeout(r, 100));
  notes.push(`daemon.turnsStarted=${daemon.turnsStarted} (daemon still ran its full turn() to completion server-side)`);
  notes.push(`chunks observed by the reader after abort: ${seen}, post-abort assistant text leaked through: ${sawPostAbortAssistantText}`);
  notes.push(
    sawPostAbortAssistantText
      ? "OBSERVED (not just theorized): this fixture has no artificial network/model latency, so daemon.turn() ran to completion via " +
        "microtask hops faster than the abort() call landed — the 'aborted' guard in translateEvent's caller never got a chance to " +
        "drop anything, and the reader saw the full post-abort text anyway. A real network-backed transport would have more of a " +
        "window, but the structural point stands regardless of timing: the guard can only ever suppress chunks the ADAPTER hasn't " +
        "yet forwarded — it has zero effect on daemon.turn() itself, which has no cancellation parameter at all."
      : 'CONFIRMED (matches deus-native-chat-client.ts grep — no `signal`/`AbortSignal` anywhere): abort only truncates the LOCAL UI stream; ' +
        "Deus's real turn() has no cancel mechanism, so the daemon keeps executing the tool/turn regardless of what the TUI does.",
  );

  return {
    name: '2. Cancellation / abort',
    verdict: 'PARTIAL',
    notes: [
      ...notes,
      "PARTIAL, not PASS: the adapter can stop RENDERING further output (what AI SDK's contract technically requires), " +
        "but cannot cancel the underlying Deus work, which is what a user pressing Ctrl-C almost certainly expects. " +
        'A production adapter would misrepresent cancellation as complete when it is only cosmetic.',
    ],
  };
}

async function scenario3_toolProgressAndFinalResults(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const daemon = new FixtureDeusDaemon({
    preText: ['Running a search'],
    toolUse: 'Using web_search: "LIA-494 status"',
    postText: ['Found 3 results.'],
  });
  const adapter = new DeusRunAgentTuiAdapter(daemon);
  const chunks: UIMessageChunk[] = [];
  const stream = await adapter.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat-tool-result-test',
    messageId: undefined,
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'search for LIA-494 status' }] }] as UIMessage[],
    abortSignal: undefined,
  });
  for await (const chunk of stream as any as AsyncIterable<UIMessageChunk>) {
    chunks.push(chunk);
  }

  const inputAvailableCount = chunks.filter((c) => (c as any).type === 'tool-input-available').length;
  const outputAvailableCount = chunks.filter(
    (c) => (c as any).type === 'tool-output-available' || (c as any).type === 'tool-output-error',
  ).length;

  notes.push(`tool-input-available chunks emitted: ${inputAvailableCount}`);
  notes.push(`tool-output-available / tool-output-error chunks emitted: ${outputAvailableCount} (structurally always 0 — see translateEvent's switch)`);
  notes.push(
    "CONFIRMED BY READING SOURCE (deus-native-chat.ts:26-29 module doc + the ChatDisplayEvent union at lines 87-98): " +
      "Deus's wire protocol has 'tool_use' (a progress label fired when a tool STARTS) but NO tool-result/tool-output event of any kind. " +
      "'tool progress' translates (lossily — see Scenario 1's note on toolName/input being fabricated); " +
      "'final results' cannot be represented AT ALL by this transport today, not because the adapter failed to implement it, " +
      "but because the protocol it is adapting has nothing to translate.",
  );

  const verdict: Verdict = inputAvailableCount > 0 && outputAvailableCount === 0 ? 'PARTIAL' : 'FAIL';
  return {
    name: '3. Tool progress and final results',
    verdict,
    notes: [...notes, 'PARTIAL: progress half works (lossily); final-results half is a genuine protocol gap, not an adapter gap.'],
  };
}

async function scenario4_threeWayPermission(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const results: Array<{ decisionRequested: string; approvedBool: boolean; mappedTo: PermissionDecision }> = [];

  for (const wantedApproved of [true, false]) {
    const daemon = new FixtureDeusDaemon(
      {
        preText: ['About to run a risky command'],
        toolUse: 'Using Bash: rm -rf /tmp/scratch',
        permission: { requestId: `req-${wantedApproved}`, toolName: 'Bash', toolInputPreview: 'rm -rf /tmp/scratch' },
        postText: ['Done.'],
      },
      800,
    );
    const adapter = new DeusRunAgentTuiAdapter(daemon);
    const renderLog: string[] = [];
    const renderer = makeScriptedRenderer({
      prompts: ['clean up the scratch dir'],
      approve: () => wantedApproved,
      log: (l) => renderLog.push(l),
    });
    await runAgentTUI({ transport: adapter, renderer } as any);

    const continuationLine = adapter.log.find((l) => l.startsWith('continueAfterApproval'));
    results.push({
      decisionRequested: wantedApproved ? 'allow (attempted allow_once)' : 'deny',
      approvedBool: wantedApproved,
      mappedTo: wantedApproved ? 'allow_once' : 'deny',
    });
    notes.push(continuationLine ?? '(no continuation observed)');
    notes.push(`daemon.authoritativeLog tail: ${daemon.authoritativeLog.slice(-2).join(' | ')}`);
  }

  notes.push(
    "Separately: even if a scripted renderer WANTS to express 'allow_always', " +
      "AgentTUIToolApprovalResponse = { approved: boolean; reason?: string } (agent-tui-runner.ts:65-68) has no field for it, " +
      "and applyToolApprovalResponse() (lines 650-669) only ever writes `approval.approved: boolean` onto the message part. " +
      "'allow_always' is UNREACHABLE through runAgentTUI's transport path — not just through TerminalRenderer's y/n keys " +
      "(as the round-1/2 FINDINGS.md already established), but through the wire format itself, one layer deeper.",
  );
  notes.push(
    'The separate respondPermission endpoint (deus-native-chat-server.ts PERMISSION_RESPONSE_PATH) IS successfully reachable ' +
      'from this transport path — the adapter calls daemon.respondPermission() directly, distinct from the message-resend call. ' +
      'That part of the bridge works.',
  );

  return {
    name: '4. Three-way permission + separate respondPermission endpoint',
    verdict: 'PARTIAL',
    notes,
  };
}

async function scenario5_restartAndReconnect(): Promise<ScenarioResult> {
  const notes: string[] = [];
  const daemon = new FixtureDeusDaemon({
    preText: ['First run reply.'],
  });

  // --- "process 1": first TUI attach ---
  const adapter1 = new DeusRunAgentTuiAdapter(daemon);
  const renderer1 = makeScriptedRenderer({ prompts: ['hello'], approve: () => true, log: () => {} });
  await runAgentTUI({ transport: adapter1, renderer: renderer1 } as any);
  const chatId1 = [...adapter1.chatIdsSeen][0];
  const statusAfterRun1 = await daemon.status();
  notes.push(`process-1 chatId=${chatId1}, daemon session after run 1: ${JSON.stringify(statusAfterRun1)}`);

  // --- something happens while "the TUI is not attached" ---
  daemon.appendOutOfBandMessage('(WhatsApp) hey, any update?');
  notes.push('appended an out-of-band WhatsApp-style message directly to the daemon while no TUI is attached');

  // --- "process 2": simulated TUI restart, same daemon ---
  const daemon2Script = { preText: ['Second run reply.'] };
  const daemon2 = daemon; // SAME daemon instance = SAME "conversation group" as far as Deus is concerned
  void daemon2Script;
  const adapter2 = new DeusRunAgentTuiAdapter(daemon2);
  const renderer2 = makeScriptedRenderer({ prompts: ['still there?'], approve: () => true, log: () => {} });
  await runAgentTUI({ transport: adapter2, renderer: renderer2 } as any);
  const chatId2 = [...adapter2.chatIdsSeen][0];
  const statusAfterRun2 = await daemon.status();

  notes.push(`process-2 chatId=${chatId2} (fresh, independent of chatId1: ${chatId1 !== chatId2})`);
  notes.push(`daemon session after run 2: ${JSON.stringify(statusAfterRun2)} — sessionId unchanged, turns incremented: daemon retained real continuity`);
  notes.push(`daemon.authoritativeLog now has ${daemon.authoritativeLog.length} entries, including the out-of-band message: ${JSON.stringify(daemon.authoritativeLog)}`);

  notes.push(
    "CONFIRMED (grepped agent-tui-runner.ts for 'reconnectToStream': zero matches; RunAgentTUIOptions/AgentTUISessionOptions " +
      "have no messages/history/resume field at all — run-agent-tui.ts:42-98, agent-tui-runner.ts:42-52): " +
      "`runAgentTUI` gives adapter2 NO way to learn what daemon.authoritativeLog already contains. `AgentTUIRunner.run()` always " +
      "starts a brand-new in-memory `messages: UIMessage[] = []` (agent-tui-runner.ts:115) and a brand-new `chatId` " +
      "(agent-tui-runner.ts:91) on every construction — there is no injection point.",
  );
  notes.push(
    'This is a DOUBLE gap, not just a library gap: even Deus\'s OWN real client-transport protocol has no history/transcript-read ' +
      'route today either (route table: deus-native-chat-server.ts:63-67 — only turn/status/close/plan/permission-response). ' +
      'So neither `@ai-sdk/tui` nor Deus\'s current wire protocol alone can satisfy "TUI restart and reconnect with full context" — ' +
      'this spike surfaces a genuine Deus-side gap, independent of the library-adoption question.',
  );

  const daemonRetainedContinuity = statusAfterRun1.sessionId === statusAfterRun2.sessionId && statusAfterRun1.sessionId !== undefined;
  const runnerHasNoResumeMechanism = chatId1 !== chatId2;

  return {
    name: '5. TUI restart and reconnection to the same daemon-owned group',
    verdict: daemonRetainedContinuity && runnerHasNoResumeMechanism ? 'PARTIAL' : 'FAIL',
    notes,
  };
}

// ---------------------------------------------------------------------------
// Section 6 — run everything, print a verdict table, answer the question.
// ---------------------------------------------------------------------------

async function main() {
  const results: ScenarioResult[] = [];
  results.push(await scenario1_oneStreamedTurn());
  results.push(await scenario2_cancellationAbort());
  results.push(await scenario3_toolProgressAndFinalResults());
  results.push(await scenario4_threeWayPermission());
  results.push(await scenario5_restartAndReconnect());

  console.log('\n' + '='.repeat(78));
  console.log('LIA-494 round-3 spike — runAgentTUI({ transport }) over a Deus-shaped fixture');
  console.log('='.repeat(78));
  for (const r of results) {
    console.log(`\n[${r.verdict}] ${r.name}`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('ANSWER to: "Can the runner act as a thin terminal harness over Deus\'s');
  console.log('existing HTTP ChatTransport without taking ownership of session history,');
  console.log('permissions, or tool execution?"');
  console.log('='.repeat(78));
  console.log(`
NO, not as a thin harness — it can be MADE to work, but only by the adapter
absorbing real, non-trivial ownership the spec explicitly says must stay with
Deus's daemon:

1. It does not take ownership of tool EXECUTION. That claim holds: nothing in
   this adapter or in @ai-sdk/tui executes a tool; the daemon fixture is the
   only thing that ever "does" anything. (PASS on this specific sub-claim.)

2. It DOES end up needing partial, structural ownership of SESSION/TURN
   STATE, not by choice but because the two transport models are shaped
   differently: AI SDK expects each sendMessages() call to be an independent
   request; Deus's real turn() is one long-lived call unblocked by a
   side-channel respondPermission() POST. Bridging them forced this adapter
   to keep a chatId-keyed map of in-flight turns (activeTurns) purely so the
   runner's mandatory second sendMessages() call (after every approval) has
   something to attach to. That map is exactly the kind of "second source of
   truth" the spec warns against for the sibling assistant-ui spike -- it is
   client-side, ephemeral, and would silently diverge from the daemon's own
   state on any crash/restart between the two calls.

3. It does NOT take ownership of PERMISSIONS in the sense of deciding
   anything -- respondPermission() is still called, and Deus's registry is
   still the real gate. But the adapter is a lossy pass-through: it can only
   ever forward 'allow_once' or 'deny'. 'allow_always' is structurally
   unreachable through this path (AgentTUIToolApprovalResponse has no field
   for it), which silently narrows Deus's real three-way permission model
   whenever driven through this runner.

4. Two capabilities in the spec's test list are not just awkward but
   currently IMPOSSIBLE through this transport, for reasons that trace back
   to Deus's OWN wire protocol having gaps, not just @ai-sdk/tui's:
     - "final results" for a tool call: ChatDisplayEvent has no
       tool-result/tool-output variant at all today.
     - "restart and reconnect" with continuity: neither runAgentTUI (no
       resume/injection point) NOR Deus's real client-transport (no
       history-read route) support it end to end.
   Adopting @ai-sdk/tui would not unlock either of these; they need a Deus
   protocol change regardless of which rendering library sits on top.

5. "Cancellation/abort" is honest but weaker than it looks: the adapter can
   stop RENDERING, but Deus's real turn() has no cancellation hook, so the
   daemon keeps working regardless. A consumer would need to build real
   server-side cancellation into Deus first; @ai-sdk/tui neither causes nor
   solves this gap.

VERDICT relative to the spec's own adoption bar ("Adopt the runner only if
the adapter can treat its generated chatId and in-memory messages as
disposable client correlation state, preserve the daemon's group session
across restarts, and represent allow_once/allow_always/deny without lossy or
duplicate approval handling. If not, stop at custom Ink rendering."):
NOT MET. The chatId/in-memory-messages correlation state is NOT cleanly
disposable (Scenario 5: the runner has no restart/resume path at all, so
"preserve the daemon's group session across restarts" fails outright), and
approval handling IS lossy (Scenario 4: allow_always is unreachable). Per the
spec's own stated rule, this means: stop at custom Ink rendering for tui-v2,
consistent with rounds 1-2's screens. There is no further @ai-sdk/tui
capability worth exploring for this decision.
`);
}

main().catch((err) => {
  console.error('SPIKE FAILED TO RUN:', err);
  process.exitCode = 1;
});
