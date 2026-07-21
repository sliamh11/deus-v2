import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RuntimeActivityBroadcaster,
  withRuntimeActivityBroadcast,
} from '../../src/agent-runtimes/activity-broadcaster.js';
import {
  DENY_TIMEOUT_MS,
  PendingPermissionRegistry,
} from '../../src/agent-runtimes/permission-registry.js';
import {
  PERMISSION_DECISIONS,
  isPermissionDecision,
  type AgentRuntime,
  type PermissionDecision,
  type RunContext,
  type RunResult,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeEventSink,
  type RuntimeSession,
} from '../../src/agent-runtimes/types.js';

// The interactive-permission follow-up ticket promoted this spike's
// `PendingPermissionRegistry`/`DENY_TIMEOUT_MS` into production
// (src/agent-runtimes/permission-registry.ts) and its
// `PERMISSION_DECISIONS`/`isPermissionDecision` next to the
// `PermissionDecision` type itself (src/agent-runtimes/types.ts). The spike
// now imports the single source of truth instead of defining its own copies;
// the re-exports below keep this file's public surface (and its tests)
// unchanged.
export {
  DENY_TIMEOUT_MS,
  PendingPermissionRegistry,
  PERMISSION_DECISIONS,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Spike-only synthetic AgentRuntime — NOT the real deus-native runtime.
 * Emits a permission_request event and awaits the registry before
 * resolving, proving the round trip without touching any production
 * runtime or the real wrapToolCall.
 */
export function createSyntheticPermissionRuntime(
  registry: PendingPermissionRegistry,
  toolName = 'lia465_spike_tool',
): AgentRuntime {
  return {
    name: () => 'deus-native',
    capabilities: () => ({
      shell: false,
      filesystem: false,
      web: false,
      multimodal: false,
      handoffs: false,
      persistent_sessions: false,
      tool_streaming: false,
    }),
    startOrResume: async (_runContext: RunContext): Promise<RuntimeSession> => ({
      backend: 'deus-native',
      session_id: `lia465-spike-${crypto.randomUUID()}`,
    }),
    async runTurn(
      _runContext: RunContext,
      sessionRef: RuntimeSession,
      eventSink: RuntimeEventSink,
    ): Promise<RunResult> {
      const requestId = crypto.randomUUID();
      const requestEvent: RuntimeEvent = {
        type: 'permission_request',
        requestId,
        toolName,
        toolInputPreview: '{"example":"synthetic input"}',
        sessionId: sessionRef.session_id,
        requestedAt: new Date().toISOString(),
      };
      const decisionPromise = registry.register(requestId);
      await eventSink(requestEvent);
      const decision = await decisionPromise;
      if (decision === 'deny') {
        return {
          status: 'error',
          result: null,
          error: `permission_denied: ${toolName} (decision=${decision})`,
        };
      }
      return {
        status: 'success',
        result: `${toolName} executed (decision=${decision})`,
      };
    },
    close: async (_sessionRef: RuntimeSession): Promise<void> => {},
  };
}

export interface SpikeServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Standalone HTTP+SSE server, spike-scoped only — never registered with,
 * or reachable through, the real production `src/odysseus-server.ts`
 * dispatcher. Reuses the real `RuntimeActivityBroadcaster` class
 * unmodified. Binds 127.0.0.1-only; no auth, since this is not a shared
 * or production surface.
 */
export function startSpikeServer(
  broadcaster: RuntimeActivityBroadcaster,
  registry: PendingPermissionRegistry,
  port = 0,
): Promise<SpikeServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/activity') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const unsubscribe = broadcaster.subscribe((envelope) => {
          res.write(`id: ${envelope.id}\n`);
          res.write(`event: ${envelope.type}\n`);
          res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        });
        req.on('close', unsubscribe);
        return;
      }

      const respondMatch = req.url?.match(/^\/activity\/([^/]+)\/respond$/);
      if (req.method === 'POST' && respondMatch) {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const command = JSON.parse(body) as RuntimeCommand;
            if (command.type !== 'permission_response') {
              res.writeHead(400, { 'Content-Type': 'text/plain' }).end(
                `unsupported command type: ${String((command as { type?: unknown }).type)}`,
              );
              return;
            }
            if (!isPermissionDecision(command.decision)) {
              res
                .writeHead(400, { 'Content-Type': 'text/plain' })
                .end(`invalid decision: ${String(command.decision)}`);
              return;
            }
            const requestId = decodeURIComponent(respondMatch[1]);
            const resolved = registry.resolve(requestId, command.decision);
            res.writeHead(resolved ? 200 : 404).end();
          } catch (err) {
            res
              .writeHead(400, { 'Content-Type': 'text/plain' })
              .end(errorMessage(err));
          }
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort =
        typeof address === 'object' && address !== null
          ? address.port
          : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

export interface RoundTripResult {
  requestReceivedOverSse: boolean;
  observedRequestId: string | undefined;
  finalDecision: PermissionDecision | 'unresolved';
  runResult: RunResult;
}

/**
 * Live, end-to-end round trip: real HTTP server, real SSE connection, real
 * registry await — nothing mocked. Proves permission_request is emitted
 * through the REAL `withRuntimeActivityBroadcast` decorator (unmodified
 * production code) onto SSE, and that posting a permission_response
 * resolves the awaiting promise with that exact decision.
 */
export async function runLiveRoundTrip(
  decision: PermissionDecision = 'allow_once',
): Promise<RoundTripResult> {
  const broadcaster = new RuntimeActivityBroadcaster();
  const registry = new PendingPermissionRegistry();
  const runtime = withRuntimeActivityBroadcast(
    createSyntheticPermissionRuntime(registry),
    broadcaster,
  );
  const server = await startSpikeServer(broadcaster, registry);

  let requestReceivedOverSse = false;
  let observedRequestId: string | undefined;
  let finalDecision: PermissionDecision | 'unresolved' = 'unresolved';
  const sseController = new AbortController();

  const ssePromise = (async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/activity`, {
      signal: sseController.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('spike SSE response had no readable body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (
        !requestReceivedOverSse &&
        buffer.includes('"type":"permission_request"')
      ) {
        const match = /"requestId":"([^"]+)"/.exec(buffer);
        if (match) {
          requestReceivedOverSse = true;
          observedRequestId = match[1];
          const command: RuntimeCommand = {
            type: 'permission_response',
            requestId: observedRequestId,
            decision,
          };
          await fetch(
            `http://127.0.0.1:${server.port}/activity/${encodeURIComponent(
              observedRequestId,
            )}/respond`,
            { method: 'POST', body: JSON.stringify(command) },
          );
          finalDecision = decision;
        }
        break;
      }
    }
  })().catch(() => {
    // Aborted deliberately once the round trip is confirmed — not a failure.
  });

  try {
    // The broadcaster has no replay buffer (fire-and-forward only, per its
    // own documented contract) — starting the turn before the SSE client
    // has actually subscribed would silently lose the permission_request
    // event forever. Wait for a confirmed subscription first.
    const subscribeDeadline = Date.now() + 5_000;
    while (broadcaster.subscriberCount() === 0) {
      if (Date.now() > subscribeDeadline) {
        throw new Error(
          'spike SSE client never subscribed within 5s — aborting before publishing into a void',
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    const session = await runtime.startOrResume({
      prompt: 'lia465 spike',
      groupFolder: 'lia465-spike',
      chatJid: 'lia465-spike',
      isControlGroup: false,
    });
    const runResult = await runtime.runTurn(
      {
        prompt: 'lia465 spike',
        groupFolder: 'lia465-spike',
        chatJid: 'lia465-spike',
        isControlGroup: false,
      },
      session,
      () => {}, // no-op direct sink — the broadcaster/SSE path is what's under test
    );

    sseController.abort();
    await ssePromise;

    return {
      requestReceivedOverSse,
      observedRequestId,
      finalDecision,
      runResult,
    };
  } finally {
    await server.close();
  }
}

export async function main(): Promise<void> {
  const result = await runLiveRoundTrip('allow_once');
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.requestReceivedOverSse ||
    result.finalDecision !== 'allow_once' ||
    result.runResult.status !== 'success'
  ) {
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('LIA-465 spike failed:', errorMessage(error));
    process.exitCode = 1;
  });
}
