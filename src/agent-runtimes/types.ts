import type { AgentEffortLevel } from '../types.js';

export type AgentRuntimeId = 'claude' | 'openai' | 'llama-cpp' | 'deus-native';

export const AGENT_RUNTIME_IDS: readonly AgentRuntimeId[] = [
  'claude',
  'openai',
  'llama-cpp',
  'deus-native',
];

// Canonical accepted-value gate for AgentRuntimeId. Defined here (next to
// the type) so both `src/config.ts` and `src/ipc.ts` can import it without
// creating a circular dependency (`ipc.ts` already depends on `config.ts`).
export function parseAgentBackend(value: unknown): AgentRuntimeId | undefined {
  return typeof value === 'string' &&
    (AGENT_RUNTIME_IDS as readonly string[]).includes(value)
    ? (value as AgentRuntimeId)
    : undefined;
}

export interface RuntimeCapabilities {
  shell: boolean;
  filesystem: boolean;
  web: boolean;
  multimodal: boolean;
  handoffs: boolean;
  persistent_sessions: boolean;
  tool_streaming: boolean;
}

export interface RuntimeSession {
  backend: AgentRuntimeId;
  session_id: string;
  resume_cursor?: string;
  metadata_json?: string;
}

export interface RunContext {
  prompt: string;
  cwd?: string;
  groupFolder: string;
  chatJid: string;
  isControlGroup: boolean;
  isScheduledTask?: boolean;
  effort?: AgentEffortLevel;
  backendConfig?: Record<string, unknown>;
  imageInputs?: Array<{ relativePath: string; mediaType: string }>;
  worktreePath?: string;
  /**
   * Streaming consumer flag. When true (set by the Odysseus Web UI channel), the
   * Claude backend enables SDK partial messages so answer text and tool/thinking
   * activity stream incrementally as `output_text`/`activity` events instead of one
   * terminal blob. Absent for WhatsApp/scheduler → unchanged buffered behavior.
   */
  stream?: boolean;
  /**
   * Per-run IPC namespace key (LIA-211). When set, the container's IPC dir is
   * keyed `ipc/<groupFolder>/<runKey>` instead of `ipc/<groupFolder>`, so
   * concurrent runs that share a groupFolder (Linear dispatches/gates, each
   * with a unique chatJid) don't collide on the `_close` sentinel. Set only by
   * the linear funnel; absent for chat/dev runs (unchanged folder-keyed IPC).
   */
  ipcRunKey?: string;
}

export type RuntimeEvent =
  | { type: 'output_text'; text: string }
  // Transient thinking/tool-progress line surfaced separately from the answer
  // (Web UI renders it as a reasoning block). Sinks without a handler ignore it.
  | { type: 'activity'; text: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  // B6 (LIA-406): per-model-call usage accounting — one event per AIMessage
  // produced within a turn, emitted unconditionally. Token fields are
  // `undefined` when the provider reported no usage_metadata (explicit
  // absence, never fabricated zeros), distinguishing "a model call happened
  // but usage wasn't reported" from "no model call happened" (no event).
  // Together with RunResult.usage this is the normalized contract
  // LIA-149/LIA-320 build on.
  | {
      type: 'usage';
      sessionId: string;
      provider: string;
      model: string;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      totalTokens: number | undefined;
    }
  | { type: 'session'; sessionRef: RuntimeSession }
  | { type: 'turn_complete' }
  | { type: 'error'; error: string };

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;

export interface RunResult {
  status: 'success' | 'error';
  result: string | null;
  sessionRef?: RuntimeSession;
  // B6 (LIA-406): turn-level aggregate, summed across the AIMessages in the
  // turn that DID carry usage_metadata. Omitted entirely (never a fabricated
  // zero-object) when no message in the turn reported usage — the
  // per-message 'usage' events above represent that absence explicitly.
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export interface AgentRuntime {
  name(): AgentRuntimeId;
  capabilities(): RuntimeCapabilities;
  startOrResume(runContext: RunContext): Promise<RuntimeSession>;
  runTurn(
    runContext: RunContext,
    sessionRef: RuntimeSession,
    eventSink: RuntimeEventSink,
  ): Promise<RunResult>;
  close(sessionRef: RuntimeSession): Promise<void>;
}

export function defaultSession(
  sessionId: string,
  backend: AgentRuntimeId = 'claude',
): RuntimeSession {
  return {
    backend,
    session_id: sessionId,
  };
}
