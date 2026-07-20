/**
 * MCP-ready marker convention (LIA-461): an out-of-band, adaptive readiness
 * signal an MCP server writes for its own spawning `ClaudeCliSessionPool` to
 * poll for — independent of the CLI's own one-shot `system/init` event, whose
 * status snapshot is captured once (immutable) and cannot be re-observed if
 * captured too early (see `claude-cli-session-pool.ts`'s `SessionRecord.initReceivedAt`
 * doc comment). Deliberately a separate file from `stream-json-protocol.ts`,
 * which is documented as "PURE parsing/typing only — no I/O, no process, no
 * clock" — a marker-file write is real I/O and does not belong there.
 *
 * Convention: the spawning pool passes the marker's absolute path via the
 * `DEUS_MCP_READY_MARKER_PATH` env var (only when a caller opts in via
 * `CreateConversationOptions.waitForMcpReady`). The MCP server calls
 * `writeMcpReadyMarkerIfRequested()` from its `server.oninitialized` callback
 * — code-review finding (LIA-461): NOT from `server.connect(transport)`
 * resolving, which was the original design here. Verified directly against
 * the MCP SDK's `Protocol.connect()` source: it only `await`s
 * `transport.start()` — it never waits for the CLIENT (the `claude` CLI
 * process) to complete its side of the `initialize`/`initialized` handshake.
 * `oninitialized` fires only once the client's `notifications/initialized`
 * arrives, which is the genuine handshake-complete signal — the earlier
 * connect()-based design could resolve the pool's wait before the CLI
 * considered the MCP server usable, reproducing a narrower version of the
 * exact race this mechanism exists to close. Absent env var => no-op, so this
 * is a strict no-behavior-change default for any server invocation that
 * hasn't opted in.
 */

import fs from 'node:fs';

export const MCP_READY_MARKER_ENV_VAR = 'DEUS_MCP_READY_MARKER_PATH';

/** Called from an MCP server's `server.oninitialized` callback (registered
 *  before `connect()`, since the notification could arrive quickly after).
 *  No-op unless the spawning pool requested a marker via the env var. */
export function writeMcpReadyMarkerIfRequested(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const markerPath = env[MCP_READY_MARKER_ENV_VAR];
  if (markerPath === undefined || markerPath === '') return;
  fs.writeFileSync(markerPath, '');
}
