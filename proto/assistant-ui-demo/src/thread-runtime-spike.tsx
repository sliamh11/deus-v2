/**
 * LIA-493 prototype (round 3) — feature-exploration spike, NOT a screen.
 *
 * Target named by the design spec ("One additional feature-exploration
 * target" under `@assistant-ui/react-ink`): `useRemoteThreadListRuntime`
 * plus `RemoteThreadListAdapter` and per-thread `ThreadHistoryAdapter`.
 *
 * Question this spike answers, verbatim from the spec: "Can assistant-ui's
 * thread/history runtime serve as a client-side projection over Deus's
 * daemon-owned sessions without becoming a second source of truth?"
 *
 * This is a REAL, running spike: it mounts a genuine
 * `useRemoteThreadListRuntime` + `AssistantRuntimeProvider` tree (via
 * `@assistant-ui/react-ink`'s real, non-mocked runtime core) under Ink,
 * wires a `RemoteThreadListAdapter` + `ThreadHistoryAdapter` +
 * `ChatModelAdapter` against a fixture that reproduces Deus's ACTUAL
 * daemon-side shapes and transport contract (cited below by file:line, read
 * first-hand in `deus-v2-mvp` — not cross-package-imported, same
 * "mirroring" precedent FINDINGS.md documents for screens 1/2 in this
 * worktree, since this throwaway package isn't wired into that repo's own
 * module graph/tsconfig), then drives the six scenarios the spec names and
 * reports PASS/FAIL/INCONCLUSIVE for each with the reasoning.
 *
 * Real shapes mirrored here (verified by reading the source, this session):
 * - `PermissionDecision`            — src/agent-runtimes/types.ts:122
 * - `ChatDisplayEvent`              — src/cli/deus-native-chat.ts:87-98
 * - `RuntimeSession`                — src/agent-runtimes/types.ts:32-37
 * - `messages` table row shape      — src/db.ts:35-46 (CREATE TABLE messages)
 * - `storeMessage` (INSERT OR REPLACE, upsert-by (id, chat_jid))
 *                                   — src/db.ts:504-517
 * - `getMessagesSince` (ORDER BY timestamp, chronological re-sort)
 *                                   — src/db.ts:555-587
 * - `ChatTransport` (turn/respondPermission/status/close)
 *                                   — src/cli/deus-native-chat-client.ts:125-138
 * - `/v1/native-chat/turn` handler (single `turnInFlight` gate, NDJSON
 *   `res.write`, `res.writable` dead-socket guard)
 *                                   — src/cli/deus-native-chat-server.ts:196-286
 * - `/v1/native-chat/permission-response` (stateless, keyed only by
 *   `requestId`, works independent of the turn's own connection)
 *                                   — src/cli/deus-native-chat-server.ts:327-382
 * - `PendingPermissionRegistry` + `DENY_TIMEOUT_MS` (120s server-side
 *   auto-deny, independent of any client connection)
 *                                   — src/agent-runtimes/permission-registry.ts:17-53
 * - `deus chat`'s module doc: no history UI, no session picker, no
 *   transcript export — CLI turns are never written to the `messages`
 *   table at all (confirmed by reading `deus-native-chat.ts` end to end:
 *   the only persisted state per turn is the opaque `RuntimeSession`
 *   `session_id`/`resume_cursor`)
 *                                   — src/cli/deus-native-chat.ts:1-33, 73-152
 *
 * Non-goals (explicitly out of scope, per the spec and the dispatch brief):
 * - `createFileStorageAdapter` is NOT evaluated as canonical persistence —
 *   it is never imported here.
 * - No interactive permission chooser UI — screen 1
 *   (`src/permission-screen.tsx`) already covers that ground; this spike's
 *   fixture answers pending permissions programmatically so the test
 *   sequence stays deterministic and non-interactive.
 * - No new diff rendering — screen 2 (`src/diff-screen.tsx`) owns that.
 *
 * RECONCILE note (GPT-5.6-Sol review finding #4, CONFIRMED-SPEC-VIOLATION):
 * the Per-Candidate Application Plan's task text asks to "test one real
 * conversation group" through the daemon. This spike does NOT do that — it
 * runs `DeusDaemonFixture`, an in-memory, structurally-faithful stand-in
 * (verified against real code shapes/semantics, cited above by file:line),
 * seeded with a synthetic group ("wa-family-group") and synthetic message
 * content, not a live daemon process or an actual user conversation.
 *
 * NOT FIXED, and deliberately so, after checking: `store/messages.db` in
 * this host's deus-v2-mvp checkout does contain real conversation groups
 * with real personal message content. Seeding this fixture from that data
 * (or driving the spike against a live daemon serving it) would put real
 * personal chat content into a file this reconcile step commits and pushes
 * to a shared branch — a straightforward violation of this repo's own data
 * rules (core-behavioral-rules.md § Data & Security: "Public repo changes
 * must be user-agnostic. Personal fixtures/IDs stay in local paths.") and
 * of the deep-verification default to treat PII conservatively. A synthetic
 * fixture that is honest ABOUT being synthetic is the safe resolution here,
 * not a literal reading of "one real group" that would require exposing
 * real family conversations in a pushed branch. The underlying spec
 * instruction is genuinely unmet; this note makes that explicit instead of
 * the file silently overclaiming realism it doesn't have. A real fix would
 * need either a disposable/synthetic daemon+group fixture seeded through
 * the ACTUAL server/db code paths (not reimplemented, as here) or a
 * throwaway local group created and torn down for the test — both out of
 * scope for a reconcile-stage fix to a throwaway prototype's exploration
 * spike.
 */
import { render, Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useRemoteThreadListRuntime,
  useAui,
  fromThreadMessageLike,
  generateId,
  type AssistantRuntime,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ThreadMessageLike,
  type MessageStatus,
} from "@assistant-ui/react-ink";

// ---------------------------------------------------------------------------
// Deus real shapes, mirrored locally (see header for file:line provenance).
// ---------------------------------------------------------------------------

/** src/agent-runtimes/types.ts:122 */
type PermissionDecision = "allow_once" | "allow_always" | "deny";

/** src/agent-runtimes/permission-registry.ts:17 */
const DENY_TIMEOUT_MS = 120_000;

/** src/cli/deus-native-chat.ts:87-98 */
type ChatDisplayEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; label: string }
  | { kind: "progress"; text: string }
  | {
      kind: "permission_request";
      requestId: string;
      toolName: string;
      toolInputPreview: string;
    }
  | { kind: "assistant_done" }
  | { kind: "chat_error"; message: string };

/** src/agent-runtimes/types.ts:32-37 */
interface RuntimeSession {
  backend: "claude" | "openai" | "llama-cpp" | "deus-native";
  session_id: string;
  resume_cursor?: string;
}

/**
 * `messages` table row — src/db.ts:35-46 (schema) / src/types.ts `NewMessage`.
 * `timestamp` is compared lexically (ISO 8601), exactly like the real
 * `getMessagesSince` (db.ts:555-587) and `getNewMessages` (db.ts:519-553).
 */
interface NewMessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
}

// ---------------------------------------------------------------------------
// Daemon fixture — reproduces the persisted + transport-level behavior a
// real integration would sit on top of. Two independent stores, matching
// what was actually found by reading the production code:
//   1. `messages` (src/db.ts) — the ONLY durable, replayable transcript
//      Deus has today, populated by the WhatsApp/Telegram channel bridges.
//   2. A per-group `RuntimeSession` — an OPAQUE resume cursor into the
//      underlying runtime's own checkpointer, not a transcript at all.
// `deus chat` CLI turns are never written into (1) — confirmed by reading
// deus-native-chat.ts, which never calls storeMessage. This fixture
// reproduces that gap faithfully rather than inventing a nicer daemon.
// ---------------------------------------------------------------------------

type Sink = (event: ChatDisplayEvent) => void;

interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInputPreview: string;
  resolve: (decision: PermissionDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface GroupRecord {
  groupFolder: string;
  chatJid: string;
  label: string;
  messages: NewMessageRow[];
  session?: RuntimeSession;
  /** Mirrors server.ts:199's single in-flight-turn gate (409-equivalent). */
  turnInFlight: boolean;
  /**
   * Bumped by every `startTurn` call and by `disconnectCurrent`. Each turn's
   * `emit` closure captures the generation it was born with and only writes
   * while it still matches — modeling the real server's per-request `res`
   * object + `res.writable` guard (server.ts:249,257,266,278,280): once a
   * NEWER request/connection exists (or the old one is explicitly killed),
   * writes attributable to the OLD turn become permanent no-ops. There is no
   * requestId/turn-keyed event buffer anywhere in the real code, so there is
   * nothing to replay to a later connection either — confirmed by reading
   * deus-native-chat-server.ts end to end.
   */
  connectionGeneration: number;
  pendingPermission?: PendingPermission;
}

let fixtureIdCounter = 0;
function fixtureId(prefix: string): string {
  fixtureIdCounter += 1;
  return `${prefix}-${fixtureIdCounter}`;
}

class DeusDaemonFixture {
  private groups = new Map<string, GroupRecord>();

  registerGroup(groupFolder: string, chatJid: string, label: string): void {
    this.groups.set(groupFolder, {
      groupFolder,
      chatJid,
      label,
      messages: [],
      turnInFlight: false,
      connectionGeneration: 0,
    });
  }

  listGroups(): GroupRecord[] {
    return [...this.groups.values()];
  }

  private mustGet(groupFolder: string): GroupRecord {
    const group = this.groups.get(groupFolder);
    if (!group) throw new Error(`unknown group "${groupFolder}"`);
    return group;
  }

  lastMessageAt(groupFolder: string): Date | undefined {
    const rows = this.mustGet(groupFolder).messages;
    if (rows.length === 0) return undefined;
    return new Date(rows[rows.length - 1]!.timestamp);
  }

  /** src/db.ts:504-517 — INSERT OR REPLACE, upsert keyed by (id, chat_jid). */
  storeMessage(groupFolder: string, row: NewMessageRow): void {
    const group = this.mustGet(groupFolder);
    const idx = group.messages.findIndex((m) => m.id === row.id);
    if (idx >= 0) group.messages[idx] = row;
    else group.messages.push(row);
  }

  /**
   * src/db.ts:555-587 — filter by timestamp, re-sort chronologically. Order
   * of `storeMessage` CALLS does not determine the returned order; the
   * `timestamp` field does — exactly like the real SQL `ORDER BY timestamp`.
   */
  getMessagesSince(groupFolder: string, since = ""): NewMessageRow[] {
    return this.mustGet(groupFolder)
      .messages.filter((m) => m.timestamp > since)
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Simulates a WhatsApp/Telegram message landing directly in the daemon's
   * `messages` table — the TUI/CLI is not involved at all, matching how the
   * real channel bridges call `storeMessage` independent of any chat
   * client's connection state.
   */
  simulateChannelInbound(
    groupFolder: string,
    content: string,
    opts: { fromMe?: boolean; id?: string; timestamp?: string } = {},
  ): void {
    const group = this.mustGet(groupFolder);
    this.storeMessage(groupFolder, {
      id: opts.id ?? fixtureId("chan-msg"),
      chat_jid: group.chatJid,
      sender: opts.fromMe ? "deus-bot" : "+1555-0100",
      sender_name: opts.fromMe ? "Deus" : "User",
      content,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      is_from_me: opts.fromMe ?? false,
      is_bot_message: opts.fromMe ?? false,
    });
  }

  /**
   * Simulates the client process dying (or the socket dropping) without a
   * replacement connection yet existing: bumps the generation so any
   * turn already in flight can no longer deliver events to anyone.
   */
  disconnectCurrent(groupFolder: string): void {
    this.mustGet(groupFolder).connectionGeneration += 1;
  }

  /**
   * Mirrors POST /v1/native-chat/turn (server.ts:201-286): single
   * in-flight-turn gate, one `permission_request` mid-turn, then
   * `assistant_text` + `assistant_done`. Each call gets its OWN generation
   * (mirroring a fresh `res` object per HTTP request) so a second call
   * while one is in flight cannot receive the FIRST call's later output —
   * it only ever gets its own immediate "already in progress" error, exactly
   * like a brand-new request in the real server. Runs to completion on the
   * daemon regardless of connection state — real `controller.runTurn(...)`
   * is not paused by a dead response socket, only its WRITES are silenced.
   */
  startTurn(groupFolder: string, prompt: string, sink: Sink): void {
    const group = this.mustGet(groupFolder);
    const gen = (group.connectionGeneration += 1);
    const emit = (event: ChatDisplayEvent) => {
      if (group.connectionGeneration === gen) sink(event);
    };
    if (group.turnInFlight) {
      emit({
        kind: "chat_error",
        message: "a chat turn is already in progress",
      });
      return;
    }
    group.turnInFlight = true;
    void this.runTurnInternal(group, prompt, emit);
  }

  private async runTurnInternal(
    group: GroupRecord,
    prompt: string,
    emit: Sink,
  ): Promise<void> {
    try {
      emit({ kind: "progress", text: "Using search…" });
      const requestId = fixtureId("perm");
      const decision = await new Promise<PermissionDecision>((resolve) => {
        const timeout = setTimeout(() => {
          group.pendingPermission = undefined;
          resolve("deny");
        }, DENY_TIMEOUT_MS);
        group.pendingPermission = {
          requestId,
          toolName: "delete_file",
          toolInputPreview: "/tmp/scratch.txt",
          resolve,
          timeout,
        };
        emit({
          kind: "permission_request",
          requestId,
          toolName: "delete_file",
          toolInputPreview: "/tmp/scratch.txt",
        });
      });
      if (decision === "deny") {
        emit({ kind: "chat_error", message: "permission denied" });
        return;
      }
      emit({ kind: "assistant_text", text: `Done: ${prompt}` });
      emit({ kind: "assistant_done" });
    } finally {
      group.turnInFlight = false;
    }
  }

  /**
   * Mirrors POST /v1/native-chat/permission-response (server.ts:327-382 +
   * PendingPermissionRegistry.resolve, permission-registry.ts:44-51):
   * stateless, keyed only by `requestId` — works whether or not the
   * original NDJSON connection/sink is still attached.
   */
  respondPermission(
    groupFolder: string,
    requestId: string,
    decision: PermissionDecision,
  ): boolean {
    const group = this.mustGet(groupFolder);
    if (group.pendingPermission?.requestId !== requestId) return false;
    clearTimeout(group.pendingPermission.timeout);
    group.pendingPermission.resolve(decision);
    group.pendingPermission = undefined;
    return true;
  }

  hasPendingPermission(groupFolder: string): boolean {
    return this.mustGet(groupFolder).pendingPermission !== undefined;
  }

  getPendingPermissionRequestId(groupFolder: string): string | undefined {
    return this.mustGet(groupFolder).pendingPermission?.requestId;
  }

  messageCount(groupFolder: string): number {
    return this.mustGet(groupFolder).messages.length;
  }
}

// ---------------------------------------------------------------------------
// RemoteThreadListAdapter — projects the daemon's registered conversation
// groups as assistant-ui "threads". Every method whose real Deus-side
// endpoint does not exist THROWS rather than silently no-op'ing (a silent
// no-op would misreport a state change that never reached the daemon).
// ---------------------------------------------------------------------------

function toRemoteThreadMetadata(fixture: DeusDaemonFixture, group: GroupRecord) {
  return {
    status: "regular" as const,
    remoteId: group.groupFolder,
    title: group.label,
    lastMessageAt: fixture.lastMessageAt(group.groupFolder),
  };
}

function createDeusRemoteThreadListAdapter(
  fixture: DeusDaemonFixture,
): RemoteThreadListAdapter {
  return {
    async list() {
      return {
        threads: fixture
          .listGroups()
          .map((g) => toRemoteThreadMetadata(fixture, g)),
      };
    },
    async fetch(threadIdOrRemoteId: string) {
      const group = fixture
        .listGroups()
        .find((g) => g.groupFolder === threadIdOrRemoteId);
      if (!group) {
        throw new Error(
          `no daemon-registered group "${threadIdOrRemoteId}" — Deus groups ` +
            "are registered out-of-band (a channel attach or the fixed CLI " +
            "synthetic group), never discovered lazily by a thread-list fetch",
        );
      }
      return toRemoteThreadMetadata(fixture, group);
    },
    async initialize(threadId: string) {
      // FINDING: this is the library's "mint a brand-new remote thread on
      // first use" hook (the cloud model: a client creates threads). Deus
      // groups are never created by a chat client — every test scenario
      // below supplies an EXISTING groupFolder as the controlled `threadId`,
      // so `switchToThread` (RemoteThreadListThreadListRuntimeCore.tsx:312+)
      // takes the "already known, just fetch/attach" path and this method
      // is never reached. If it IS reached, that means the app tried to
      // start a client-originated "new conversation" — a mode Deus's
      // architecture doesn't support (the daemon must own group creation).
      throw new Error(
        `initialize("${threadId}") — Deus never lets a chat client mint a ` +
          "new conversation group; this adapter intentionally has nothing " +
          "real to call here",
      );
    },
    async rename() {
      throw new Error("rename: no daemon endpoint for group titles");
    },
    async archive() {
      throw new Error("archive: no daemon endpoint for group archival");
    },
    async unarchive() {
      throw new Error("unarchive: no daemon endpoint for group archival");
    },
    async delete() {
      throw new Error("delete: no daemon endpoint for deleting groups");
    },
    async generateTitle() {
      throw new Error("generateTitle: no daemon title-generation endpoint");
    },
  };
}

// ---------------------------------------------------------------------------
// ThreadHistoryAdapter — client-side projection of `messages` (src/db.ts).
// FINDING (see header): CLI-native-chat turns are NOT written to `messages`
// in production today. `append()` below writes into the fixture's
// `messages` store anyway, because it is the ONLY daemon-side store that
// exists — which is precisely the "second source of truth" risk the spec
// asks this spike to check for. See the reported verdict for the honest
// conclusion this produces.
// ---------------------------------------------------------------------------

const COMPLETE_STATUS: MessageStatus = { type: "complete", reason: "unknown" };

function rowsToRepository(rows: NewMessageRow[]) {
  const likeMessages: ThreadMessageLike[] = rows.map((r) => ({
    role: r.is_bot_message ? "assistant" : "user",
    content: r.content,
  }));
  const converted = likeMessages.map((m) =>
    fromThreadMessageLike(m, generateId(), COMPLETE_STATUS),
  );
  return {
    messages: converted.map((message, i) => ({
      parentId: i > 0 ? converted[i - 1]!.id : null,
      message,
    })),
  };
}

function createDeusHistoryAdapter(
  fixture: DeusDaemonFixture,
  groupFolder: string,
): ThreadHistoryAdapter {
  return {
    async load() {
      return rowsToRepository(fixture.getMessagesSince(groupFolder));
    },
    async append(item) {
      const text = item.message.content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      fixture.storeMessage(groupFolder, {
        id: item.message.id,
        chat_jid: fixture
          .listGroups()
          .find((g) => g.groupFolder === groupFolder)!.chatJid,
        sender: item.message.role === "assistant" ? "deus-bot" : "cli-user",
        sender_name: item.message.role === "assistant" ? "Deus" : "CLI user",
        content: text,
        // `item.message.createdAt` is a real Date on every ThreadMessage;
        // used as the ordering key exactly like the real `timestamp` column.
        timestamp: item.message.createdAt.toISOString(),
        is_from_me: item.message.role === "assistant",
        is_bot_message: item.message.role === "assistant",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// ChatModelAdapter — translates the fixture's push-based ChatDisplayEvent
// stream into assistant-ui's accumulated ChatModelRunResult yields, exactly
// the shape a real integration adapter over `ChatTransport.turn()` would
// need to write. Approval is answered out-of-band by the test harness
// (via `fixture.respondPermission`), not by a UI chooser — see header.
// ---------------------------------------------------------------------------

function createDeusChatModelAdapter(
  fixture: DeusDaemonFixture,
  groupFolder: string,
): ChatModelAdapter {
  return {
    async *run({ messages }): AsyncGenerator<ChatModelRunResult> {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const promptText =
        lastUser?.content
          .map((part) => ("text" in part ? part.text : ""))
          .join("") ?? "";

      const queue: ChatDisplayEvent[] = [];
      let wake: (() => void) | undefined;
      const sink: Sink = (event) => {
        queue.push(event);
        wake?.();
        wake = undefined;
      };
      fixture.startTurn(groupFolder, promptText, sink);

      let text = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const event = queue.shift()!;
        switch (event.kind) {
          case "assistant_text":
            text += event.text;
            yield { content: [{ type: "text", text }] };
            break;
          case "progress":
          case "tool_use":
          case "permission_request":
            // Not modeled as message content in this minimal spike — the
            // real interactive chooser is screen 1's subject, not this
            // one's. The test harness answers via fixture.respondPermission
            // directly.
            break;
          case "assistant_done":
            return;
          case "chat_error":
            yield {
              content: [{ type: "text", text }],
              status: {
                type: "incomplete",
                reason: "error",
                error: event.message,
              },
            };
            return;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Per-thread runtime hook — reads the CURRENT thread's remoteId from
// assistant-ui's own store (useAui().threadListItem()) the same way the
// real `useAssistantCloudThreadHistoryAdapter` canonical example does
// (AssistantCloudThreadHistoryAdapter.ts:30-39), then wires a fresh
// history+chatModel pair scoped to that group. `useLocalRuntime` itself is
// implemented on top of `useRemoteThreadListRuntime` internally
// (@assistant-ui/core's useLocalRuntime.ts:103-115, confirmed by reading
// it) — this composition is not a spike-only trick, it's how the library's
// own local-runtime hook is built.
// ---------------------------------------------------------------------------

function useDeusThreadRuntime(fixture: DeusDaemonFixture) {
  const aui = useAui();
  const remoteId = aui.threadListItem().getState().remoteId;
  const groupFolder = remoteId ?? "";

  const history = useMemo(
    () => (remoteId ? createDeusHistoryAdapter(fixture, remoteId) : undefined),
    [fixture, remoteId],
  );
  const chatModel = useMemo(
    () => createDeusChatModelAdapter(fixture, groupFolder),
    [fixture, groupFolder],
  );

  return useLocalRuntime(chatModel, { adapters: { history } });
}

const GROUP_FOLDER = "wa-family-group";

function useDeusRuntime(fixture: DeusDaemonFixture): AssistantRuntime {
  const adapter = useMemo(() => createDeusRemoteThreadListAdapter(fixture), [
    fixture,
  ]);
  return useRemoteThreadListRuntime({
    adapter,
    threadId: GROUP_FOLDER,
    runtimeHook: () => useDeusThreadRuntime(fixture),
  });
}

/**
 * One "client process". Mounting `<AssistantRuntimeProvider>` is what
 * actually drives `__internal_RenderComponent`/the per-thread `runtimeHook`
 * (AssistantProvider.tsx:32-35 auto-renders it — confirmed by reading it) —
 * without this wrapper the runtime object exists but nothing inside it ever
 * runs. Remounting this component (via a `key` change on the harness side)
 * is how "the CLI process restarts" is modeled: a genuinely fresh
 * `RemoteThreadListRuntimeCore`/`RemoteThreadListHookInstanceManager`, with
 * continuity available ONLY through whatever the fixture (the daemon)
 * persisted — exactly like a real restarted `deus chat` process.
 */
function Session({
  fixture,
  onRuntime,
}: {
  fixture: DeusDaemonFixture;
  onRuntime: (runtime: AssistantRuntime) => void;
}) {
  const runtime = useDeusRuntime(fixture);
  useEffect(() => {
    onRuntime(runtime);
  }, [runtime, onRuntime]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Text dimColor>(session live)</Text>
    </AssistantRuntimeProvider>
  );
}

// ---------------------------------------------------------------------------
// Test harness — drives the six spec-named scenarios plus the
// duplicate/out-of-order dedup case, against a REAL mounted runtime.
// ---------------------------------------------------------------------------

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
interface ScenarioResult {
  name: string;
  verdict: Verdict;
  detail: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const CHAT_JID = "1205551234@g.us";

function App() {
  const fixture = useMemo(() => {
    const f = new DeusDaemonFixture();
    f.registerGroup(GROUP_FOLDER, CHAT_JID, "Family group");
    f.simulateChannelInbound(GROUP_FOLDER, "hey deus, remind me to call mom", {
      timestamp: "2026-07-28T10:00:00.000Z",
    });
    return f;
  }, []);

  const [sessionGen, setSessionGen] = useState(0);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [finished, setFinished] = useState(false);
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const onRuntime = useCallback((rt: AssistantRuntime) => {
    runtimeRef.current = rt;
  }, []);

  /** Unmount + remount the whole Session subtree — a genuine "CLI restart". */
  const restartSession = useCallback(async (): Promise<AssistantRuntime> => {
    const previous = runtimeRef.current;
    runtimeRef.current = null;
    setSessionGen((g) => g + 1);
    await waitUntil(
      () =>
        runtimeRef.current !== null &&
        runtimeRef.current !== previous &&
        runtimeRef.current.threads.getState().mainThreadId === GROUP_FOLDER,
    );
    return runtimeRef.current!;
  }, []);

  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      const out: ScenarioResult[] = [];
      const push = (name: string, verdict: Verdict, detail: string) => {
        out.push({ name, verdict, detail });
        setResults([...out]);
      };

      await waitUntil(() => runtimeRef.current !== null);
      let runtime = runtimeRef.current!;

      // ---- Scenario 1: initial CLI attach using the daemon's group/session
      // identifier as the controlled thread ID. ------------------------------
      const attached = await waitUntil(
        () => runtime.threads.getState().mainThreadId === GROUP_FOLDER,
      );
      const initialCount = runtime.thread.getState().messages.length;
      push(
        "1. initial attach: daemon groupFolder used directly as controlled threadId",
        attached && initialCount === 1 ? "PASS" : "FAIL",
        attached
          ? `mainThreadId resolved to the daemon's real groupFolder ("${GROUP_FOLDER}") with zero client-side ID translation; ` +
            `ThreadHistoryAdapter.load() surfaced the pre-existing WhatsApp message (${initialCount} loaded). ` +
            `RemoteThreadListAdapter.fetch()/list() take the daemon's real identifier as remoteId directly — no adapter-side ID mapping layer was needed.`
          : `mainThreadId never resolved to "${GROUP_FOLDER}" within the timeout.`,
      );

      // Drive one full CLI turn through the REAL runtime (not a fixture
      // shortcut) so later scenarios have a CLI-originated exchange to check
      // alongside the WhatsApp message.
      runtime.thread.append("what's the weather tomorrow");
      const gotPermission1 = await waitUntil(() =>
        fixture.hasPendingPermission(GROUP_FOLDER),
      );
      const reqId1 = fixture.getPendingPermissionRequestId(GROUP_FOLDER);
      if (gotPermission1 && reqId1) {
        fixture.respondPermission(GROUP_FOLDER, reqId1, "allow_once");
      }
      await waitUntil(
        () =>
          runtime.thread.getState().messages.length >= 3 &&
          runtime.thread.getState().messages.at(-1)?.status?.type ===
            "complete",
      );

      // ---- Scenario 2: CLI restart and history reload. --------------------
      const beforeRestartCount = fixture.messageCount(GROUP_FOLDER);
      runtime = await restartSession();
      const afterRestartMessages = runtime.thread.getState().messages;
      const restartOk =
        afterRestartMessages.length === beforeRestartCount &&
        afterRestartMessages.some((m) =>
          m.content.some(
            (p) => "text" in p && p.text.includes("Done: what's the weather"),
          ),
        );
      push(
        // RECONCILE label fix (GPT-5.6-Sol review finding #5, API-HONESTY):
        // the PASS below is real for the RUNTIME behavior under test
        // (ThreadHistoryAdapter.load() recovering everything append() wrote)
        // but relies on a persistence path this spike's own fixture adds —
        // production has no such write path for CLI turns yet (see the
        // CAVEAT in the detail string). Naming it explicitly avoids reading
        // the green PASS as "this works against the real daemon today".
        "2. CLI restart and history reload (fixture persists CLI turns; production does not yet)",
        restartOk ? "PASS" : "FAIL",
        restartOk
          ? `A fresh Session (fresh RemoteThreadListRuntimeCore, fresh ThreadHistoryAdapter.load()) recovered all ${afterRestartMessages.length} persisted messages, ` +
            `including the CLI turn's own prompt+reply. CAVEAT (real-system gap, not this adapter's doing): this only works because this ` +
            `spike's history.append() ALSO writes CLI-turn messages into the messages-table-shaped store. Production deus-native-chat.ts ` +
            `(read end-to-end this session) never calls storeMessage for a CLI turn — only the opaque RuntimeSession.resume_cursor persists ` +
            `today. A real integration would need to ADD a durable transcript write path for CLI turns that does not exist yet; without it, ` +
            `this scenario would genuinely fail against the real daemon (only the pre-existing WhatsApp message would reload).`
          : `expected ${beforeRestartCount} messages after restart incl. the CLI exchange, got ${afterRestartMessages.length}.`,
      );

      // ---- Scenario 3: a message added via WhatsApp/Telegram while the TUI
      // is disconnected. ------------------------------------------------------
      fixture.disconnectCurrent(GROUP_FOLDER); // "TUI process exits"
      fixture.simulateChannelInbound(
        GROUP_FOLDER,
        "actually nvm, I'll call her myself",
        { timestamp: "2026-07-28T11:00:00.000Z" },
      );
      const beforeReconnectCount = runtime.thread.getState().messages.length;
      runtime = await restartSession(); // "TUI reconnects"
      const afterReconnectMessages = runtime.thread.getState().messages;
      const sawChannelMsg = afterReconnectMessages.some((m) =>
        m.content.some(
          (p) => "text" in p && p.text.includes("I'll call her myself"),
        ),
      );
      push(
        "3. WhatsApp/Telegram message added while TUI disconnected, then reconnect",
        sawChannelMsg && afterReconnectMessages.length === beforeReconnectCount + 1
          ? "PASS"
          : "FAIL",
        sawChannelMsg
          ? "The cross-channel message written directly to the daemon's `messages` table while no TUI was attached at all " +
            "was picked up cleanly on the next ThreadHistoryAdapter.load() — no client-side involvement needed for this path. " +
            "This is the cleanest, most honest win for the 'client-side projection' model: it only depends on data the daemon " +
            "already owns and writes independent of any chat client (WhatsApp/Telegram bridges → src/db.ts storeMessage)."
          : "the channel message added while disconnected did not appear after reconnect.",
      );

      // ---- Scenario 4: reconnect while a tool approval is unresolved. -----
      // RECONCILE fix (GPT-5.6-Sol review findings #3 and #5): the original
      // single push() conflated two different things under one green "PASS"
      // — (a) the pending approval genuinely surviving a disconnect, which
      // IS a real win, and (b) a reconnect attempt that only ever gets a
      // "chat turn already in progress" error, which is a real capability
      // GAP, not a pass. Rendering (b) green was the regression the review
      // flagged. Split into two independently-verdicted rows so neither
      // fact is mislabeled.
      runtime.thread.append("what about the day after");
      const gotPermission2 = await waitUntil(() =>
        fixture.hasPendingPermission(GROUP_FOLDER),
      );
      fixture.disconnectCurrent(GROUP_FOLDER); // kill the connection mid-approval
      const reconnectEvents: ChatDisplayEvent[] = [];
      fixture.startTurn(GROUP_FOLDER, "reconnect probe", (e) =>
        reconnectEvents.push(e),
      );
      const stillPendingAfterReconnectAttempt = fixture.hasPendingPermission(
        GROUP_FOLDER,
      );
      const reconnectFailedAsExpected =
        reconnectEvents.length === 1 && reconnectEvents[0]?.kind === "chat_error";
      push(
        "4a. original pending approval survives a disconnect (fixture-level, mirrors PendingPermissionRegistry)",
        gotPermission2 && stillPendingAfterReconnectAttempt ? "PASS" : "FAIL",
        `Original permission_request fired: ${gotPermission2}. After disconnectCurrent() + a reconnect attempt, the ORIGINAL ` +
          `pending permission was still pending: ${stillPendingAfterReconnectAttempt} — proving the approval itself is ` +
          "daemon-held/durable (PendingPermissionRegistry, keyed by requestId, independent of any HTTP connection). This exercises " +
          "the fixture's own state, which mirrors permission-registry.ts:17-53 by construction, not assistant-ui's runtime.",
      );
      push(
        "4b. reconnect-to-in-flight-turn capability",
        reconnectFailedAsExpected ? "FAIL" : "INCONCLUSIVE",
        `A reconnect attempt that calls the real turn endpoint again (the only reconnect mechanism that exists) got exactly one ` +
          `event back: ${JSON.stringify(reconnectEvents)}. There is no "reattach to an in-flight stream" API anywhere in ` +
          "deus-native-chat-server.ts (confirmed by reading it end to end) — a reconnecting client can only ever be told a turn " +
          "is already in progress, never rejoin it. This is graded FAIL, not PASS: the capability being tested (resuming an " +
          "in-flight turn after reconnect) genuinely does not exist yet, independent of whether that failure was 'expected'.",
      );

      // ---- Scenario 5: approval resolution followed by resumed streaming. -
      const reqId2 = fixture.getPendingPermissionRequestId(GROUP_FOLDER);
      const resolved =
        reqId2 !== undefined &&
        fixture.respondPermission(GROUP_FOLDER, reqId2, "allow_once");
      const stuckMessageIndexBefore = runtime.thread.getState().messages.length - 1;
      const observedResumedOutput = await waitUntil(
        () =>
          runtime.thread.getState().messages[stuckMessageIndexBefore]
            ?.status?.type === "complete",
        500,
      );
      // Verify the reply is truly lost, not just delayed: reload from a
      // fresh restart and confirm it never made it into the daemon's store.
      runtime = await restartSession();
      const dayAfterReplyPersisted = runtime.thread
        .getState()
        .messages.some((m) =>
          m.content.some(
            (p) => "text" in p && p.text.includes("Done: what about the day after"),
          ),
        );
      push(
        // RECONCILE fix (GPT-5.6-Sol review finding #9): the verdict value
        // itself must stay within the `Verdict` union ("PASS"|"FAIL"|
        // "INCONCLUSIVE") — `npx tsc --noEmit` genuinely failed (TS2345) on
        // the previous literal-string verdict. The nuance ("spec's exact
        // phrase does not hold end-to-end") already lives verbatim in the
        // `detail` string below, so no information is lost by using the
        // plain "FAIL" tag here.
        "5. approval resolution followed by resumed streaming",
        resolved && !observedResumedOutput && !dayAfterReplyPersisted
          ? "FAIL"
          : "INCONCLUSIVE",
        `respondPermission() via the stateless requestId-keyed endpoint succeeded: ${resolved} (the daemon-side approval genuinely resolved). ` +
          `But the client-side runtime that originally asked for approval never observed ANY resumed output within 500ms (observed: ${observedResumedOutput}) — ` +
          "its connection generation had already been superseded by the disconnect + reconnect-probe in scenario 4, so the daemon's later " +
          "assistant_text/assistant_done emits had nobody left to write to (matches real res.writable semantics: once a socket dies, later " +
          `writes for that turn are silent no-ops, and there is no requestId/turn-keyed buffer to replay). Confirmed NOT just delayed: after a ` +
          `full restart, the reply is absent from persisted history too (persisted: ${dayAfterReplyPersisted}) — because history.append() for an ` +
          "assistant message only fires once its ChatModelAdapter generator RETURNS (local-thread-runtime-core.ts:568-577), and that generator " +
          "is permanently stuck awaiting events that will never arrive. Net: the daemon resumes internally and the approval is not lost, but " +
          "the resulting assistant output is unrecoverable through this transport shape as it exists today — the spec's phrase " +
          '"approval resolution followed by resumed streaming" does not hold for a genuinely disconnected+reconnected client.',
      );

      // ---- Scenario 6: duplicate/out-of-order append protection. ----------
      const dedupFixture = new DeusDaemonFixture();
      dedupFixture.registerGroup("dedup-test", "dedup@g.us", "dedup test");
      dedupFixture.storeMessage("dedup-test", {
        id: "dup-1",
        chat_jid: "dedup@g.us",
        sender: "u",
        sender_name: "U",
        content: "first attempt",
        timestamp: "2026-07-28T12:00:00.000Z",
        is_from_me: false,
        is_bot_message: false,
      });
      // Simulate a retried append delivering the SAME id again (e.g. a
      // client retry after a dropped ack) — must upsert, not duplicate.
      dedupFixture.storeMessage("dedup-test", {
        id: "dup-1",
        chat_jid: "dedup@g.us",
        sender: "u",
        sender_name: "U",
        content: "retried attempt (same id)",
        timestamp: "2026-07-28T12:00:00.000Z",
        is_from_me: false,
        is_bot_message: false,
      });
      // Out-of-order arrival: a later-timestamped row lands BEFORE an
      // earlier-timestamped one (e.g. two channel webhooks racing).
      dedupFixture.storeMessage("dedup-test", {
        id: "msg-later",
        chat_jid: "dedup@g.us",
        sender: "u",
        sender_name: "U",
        content: "sent later",
        timestamp: "2026-07-28T12:02:00.000Z",
        is_from_me: false,
        is_bot_message: false,
      });
      dedupFixture.storeMessage("dedup-test", {
        id: "msg-earlier",
        chat_jid: "dedup@g.us",
        sender: "u",
        sender_name: "U",
        content: "sent earlier, arrived second",
        timestamp: "2026-07-28T12:01:00.000Z",
        is_from_me: false,
        is_bot_message: false,
      });
      const dedupRows = dedupFixture.getMessagesSince("dedup-test");
      const dedupOk =
        dedupRows.length === 3 &&
        dedupRows[0]!.id === "dup-1" &&
        dedupRows[0]!.content === "retried attempt (same id)" &&
        dedupRows[1]!.id === "msg-earlier" &&
        dedupRows[2]!.id === "msg-later";
      push(
        // RECONCILE label fix (finding #5, API-HONESTY): this exercises the
        // FIXTURE's storeMessage/getMessagesSince, which mirror db.ts's real
        // SQL semantics by construction — it verifies Deus's own guarantee,
        // not anything assistant-ui contributes (spelled out in the detail
        // string's own IMPORTANT CAVEAT, kept verbatim below).
        "6. duplicate/out-of-order append protection (fixture-level: exercises Deus's storeMessage/getMessagesSince semantics, not assistant-ui)",
        dedupOk ? "PASS" : "FAIL",
        dedupOk
          ? "storeMessage's real INSERT OR REPLACE-by-(id,chat_jid) semantics (db.ts:504-517) correctly collapsed the retried duplicate " +
            "into one row with the latest content, and getMessagesSince's real ORDER BY timestamp (db.ts:555-587) correctly re-sorted the " +
            "out-of-order pair chronologically regardless of insertion order. IMPORTANT CAVEAT: this protection comes entirely from Deus's " +
            "OWN SQL schema/query shape, not from assistant-ui — ThreadHistoryAdapter.append()'s contract (adapters/thread-history.ts:57-73) " +
            "has no idempotency or ordering guarantee of its own; it is just \"a message was appended\". The library contributes nothing to " +
            "this guarantee, it would only inherit it by writing through Deus's existing store, unchanged."
          : `expected 3 deduped, chronologically-sorted rows, got: ${JSON.stringify(dedupRows.map((r) => r.id))}.`,
      );

      setFinished(true);
    })().catch((err) => {
      setResults((prev) => [
        ...prev,
        {
          name: "harness crashed",
          verdict: "FAIL",
          detail: String(err instanceof Error ? err.stack ?? err.message : err),
        },
      ]);
      setFinished(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deterministic exit once the scripted sequence completes — this is a
  // throwaway, non-interactive spike, not a long-lived TUI screen.
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => process.exit(0), 150);
    return () => clearTimeout(t);
  }, [finished]);

  return (
    <Box flexDirection="column">
      <Text bold>LIA-493 round 3 — thread/history runtime spike</Text>
      <Session key={sessionGen} fixture={fixture} onRuntime={onRuntime} />
      {results.map((r, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Text bold color={r.verdict.startsWith("PASS") ? "green" : r.verdict.startsWith("FAIL") ? "red" : "yellow"}>
            [{r.verdict}] {r.name}
          </Text>
          <Text wrap="wrap">{r.detail}</Text>
        </Box>
      ))}
      {finished && (
        <Box marginTop={1}>
          <Text dimColor>
            done — {results.filter((r) => r.verdict.startsWith("PASS")).length}/
            {results.length} scenarios passed
          </Text>
        </Box>
      )}
    </Box>
  );
}

render(<App />);
