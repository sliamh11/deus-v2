// LIA-496 — S1 headless verification. No UI: imports the adapter and
// threadList modules directly and drives them through real scripted
// behavior, asserting on the actual data produced. Exercises the two
// things the S1 dispatch calls out explicitly:
//   (1) a scripted turn produces expected chunks (streaming + tool-call +
//       completion shape), and
//   (2) the grant store suppresses a second identical permission request
//       — proven BOTH ways: granted (no prompt) and NOT granted (prompt
//       still appears), so this is a demonstrated conditional, not a
//       hardcoded skip.
// Also sanity-checks threadList/history/highlight/status/diffStatus so
// the whole shared surface this stage built gets touched at least once.
//
// Run with: npx tsx shared/scripts/verify-headless.ts   (from proto/)
import type { ChatModelRunOptions, ChatModelRunResult, ThreadAssistantMessagePart } from "@assistant-ui/core";
import { getFixtureAdapter, resetFixtureAdapters } from "../src/adapter";
import {
  fixtureThreadListAdapter,
  resetFixtureThreads,
  knownThreadIds,
} from "../src/threadList";
import { createHistoryAdapter, resetAllHistory } from "../src/history";
import { hasGrant, permissionKey, clearGrants } from "../src/permissions";
import { highlightToHtml, highlightToTokens } from "../src/highlight";
import { diffPanelBorderStatus, liveBulletStatus } from "../src/status";
import { countChanges } from "../src/diffStatus";

let failures = 0;
let assertions = 0;

function ok(label: string, cond: boolean, detail?: unknown): void {
  assertions += 1;
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`, detail !== undefined ? detail : "");
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function collectRun(
  adapter: ReturnType<typeof getFixtureAdapter>,
  content: readonly ThreadAssistantMessagePart[],
): Promise<ChatModelRunResult[]> {
  const options = {
    messages: [],
    runConfig: {},
    context: {},
    abortSignal: new AbortController().signal,
    unstable_getMessage: () => ({ content }) as unknown,
  } as unknown as ChatModelRunOptions;

  const results: ChatModelRunResult[] = [];
  const runResult = adapter.run(options);
  // Our adapters are always async-generator functions (see adapter.ts),
  // never the Promise<ChatModelRunResult> alternative the type also
  // allows, but branch defensively rather than assume.
  if (runResult && typeof (runResult as AsyncGenerator<ChatModelRunResult>)[Symbol.asyncIterator] === "function") {
    for await (const r of runResult as AsyncGenerator<ChatModelRunResult>) {
      results.push(r);
    }
  } else {
    results.push(await (runResult as Promise<ChatModelRunResult>));
  }
  return results;
}

function findToolCall(
  content: readonly ThreadAssistantMessagePart[],
  toolCallId: string,
): (ThreadAssistantMessagePart & { type: "tool-call" }) | undefined {
  return content.find(
    (c): c is ThreadAssistantMessagePart & { type: "tool-call" } => c.type === "tool-call" && c.toolCallId === toolCallId,
  );
}

async function scenarioGrantedPath(): Promise<void> {
  section("Scenario 1: status-glyph-fix, turn 1 approved with allow_always -> turn 3 grant-store suppression");
  resetFixtureAdapters();
  clearGrants();
  resetAllHistory();

  const adapter = getFixtureAdapter("status-glyph-fix");

  // --- Turn 1 start ---
  let results = await collectRun(adapter, []);
  ok("turn 1 yields at least one chunk", results.length > 0, results.length);
  const afterTurn1Start = results[results.length - 1]!;
  ok(
    "turn 1 ends requires-action (pending delete_file approval)",
    afterTurn1Start.status?.type === "requires-action",
    afterTurn1Start.status,
  );
  const scratchContent = [...(afterTurn1Start.content ?? [])];
  const deleteCall = findToolCall(scratchContent, "call-delete-scratch");
  ok("turn 1's delete_file tool-call has an approval field (not pre-granted)", !!deleteCall?.approval, deleteCall);
  ok(
    "grant store has NOT granted delete_file yet",
    !hasGrant(permissionKey("delete_file")),
  );
  // Confirms the streamed reasoning/text/tool-call parts actually built up
  // (not just a single opaque final chunk) — the "expected chunks" check.
  const partTypesSeen = new Set(scratchContent.map((c) => c.type));
  ok(
    "turn 1 produced reasoning, text, and tool-call parts",
    partTypesSeen.has("reasoning") && partTypesSeen.has("text") && partTypesSeen.has("tool-call"),
    [...partTypesSeen],
  );

  // --- Simulate the human resolving the approval with "Always allow" ---
  const resolvedContent = scratchContent.map((c) =>
    c.type === "tool-call" && c.toolCallId === "call-delete-scratch"
      ? { ...c, approval: { ...c.approval!, approved: true, optionId: "allow_always" } }
      : c,
  );

  // --- Turn 1 continuation ---
  results = await collectRun(adapter, resolvedContent);
  const afterTurn1Continue = results[results.length - 1]!;
  ok("turn 1 continuation completes", afterTurn1Continue.status?.type === "complete", afterTurn1Continue.status);
  ok("grant store now has delete_file granted", hasGrant(permissionKey("delete_file")));

  // --- Turn 2 (new user message -> fresh content) ---
  results = await collectRun(adapter, []);
  const afterTurn2 = results[results.length - 1]!;
  ok("turn 2 completes", afterTurn2.status?.type === "complete", afterTurn2.status);

  // --- Turn 3: the grant-store proof ---
  results = await collectRun(adapter, []);
  const neverRequiredAction = results.every((r) => r.status?.type !== "requires-action");
  ok(
    "turn 3 NEVER yields requires-action — no permission prompt rendered",
    neverRequiredAction,
    results.map((r) => r.status),
  );
  const afterTurn3 = results[results.length - 1]!;
  ok("turn 3 completes in the same run() call (auto-approved inline)", afterTurn3.status?.type === "complete", afterTurn3.status);
  const secondDeleteCall = findToolCall([...(afterTurn3.content ?? [])], "call-delete-second");
  ok(
    "turn 3's second delete_file tool-call has NO approval field — the actual suppression mechanism",
    !!secondDeleteCall && secondDeleteCall.approval === undefined,
    secondDeleteCall,
  );
}

async function scenarioDeniedPath(): Promise<void> {
  section("Scenario 2 (negative control): turn 1 DENIED -> grant never recorded -> turn 3 still prompts");
  resetFixtureAdapters();
  clearGrants();
  resetAllHistory();

  const adapter = getFixtureAdapter("status-glyph-fix");

  let results = await collectRun(adapter, []);
  const scratchContent = [...(results[results.length - 1]!.content ?? [])];
  const deleteCall = findToolCall(scratchContent, "call-delete-scratch");
  ok("turn 1's delete_file tool-call has an approval field", !!deleteCall?.approval);

  const deniedContent = scratchContent.map((c) =>
    c.type === "tool-call" && c.toolCallId === "call-delete-scratch"
      ? { ...c, approval: { ...c.approval!, approved: false, optionId: "deny" } }
      : c,
  );
  results = await collectRun(adapter, deniedContent);
  ok("turn 1 continuation (denied) completes", results[results.length - 1]!.status?.type === "complete");
  ok("grant store still has NOT granted delete_file after a deny", !hasGrant(permissionKey("delete_file")));

  results = await collectRun(adapter, []); // turn 2
  ok("turn 2 completes", results[results.length - 1]!.status?.type === "complete");

  results = await collectRun(adapter, []); // turn 3
  const requiredActionSeen = results.some((r) => r.status?.type === "requires-action");
  ok(
    "turn 3 DOES yield requires-action when delete_file was never granted — proves the suppression in scenario 1 was a real conditional, not hardcoded",
    requiredActionSeen,
    results.map((r) => r.status),
  );
  const finalContent = [...(results[results.length - 1]!.content ?? [])];
  const secondDeleteCall = findToolCall(finalContent, "call-delete-second");
  ok(
    "turn 3's second delete_file tool-call DOES have an approval field this time",
    !!secondDeleteCall?.approval,
    secondDeleteCall,
  );
}

async function scenarioThreadList(): Promise<void> {
  section("Scenario 3: FixtureThreadListAdapter — list/rename/archive/unarchive/delete/initialize/fetch");
  resetFixtureThreads();

  // 7, not 6 — S2A (web) added a 7th seeded thread ("theme-swap-crash", see
  // shared/src/fixtures/threads.ts's own comment) as a real shared-side
  // deviation: the S1 dispatch's "Consuming call sites" section requires a
  // fixture thread that throws from the adapter, for ErrorState.tsx/
  // ErrorPrimitive on both targets, and no seeded thread did that before.
  const listed = await fixtureThreadListAdapter.list();
  ok("list() returns all 7 seeded threads", listed.threads.length === 7, listed.threads.length);
  ok(
    "seeded threads include status-glyph-fix",
    listed.threads.some((t) => t.remoteId === "status-glyph-fix"),
  );
  ok(
    "seeded threads include theme-swap-crash (S2A ErrorState fixture)",
    listed.threads.some((t) => t.remoteId === "theme-swap-crash"),
  );

  await fixtureThreadListAdapter.rename("status-glyph-fix", "Status-glyph rendering fix (renamed)");
  const afterRename = await fixtureThreadListAdapter.fetch("status-glyph-fix");
  ok("rename() is a real mutation", afterRename.title === "Status-glyph rendering fix (renamed)", afterRename.title);

  await fixtureThreadListAdapter.archive("diff-panel-polish");
  const afterArchive = await fixtureThreadListAdapter.fetch("diff-panel-polish");
  ok("archive() sets status to archived", afterArchive.status === "archived", afterArchive.status);

  await fixtureThreadListAdapter.unarchive("diff-panel-polish");
  const afterUnarchive = await fixtureThreadListAdapter.fetch("diff-panel-polish");
  ok("unarchive() reverts status to regular", afterUnarchive.status === "regular", afterUnarchive.status);

  const init = await fixtureThreadListAdapter.initialize("brand-new-thread-1");
  ok("initialize() returns a remoteId", init.remoteId === "brand-new-thread-1", init);
  const afterInit = await fixtureThreadListAdapter.list();
  ok("initialize() registers the new thread in list()", afterInit.threads.length === 8, afterInit.threads.length);

  await fixtureThreadListAdapter.delete("brand-new-thread-1");
  const afterDelete = await fixtureThreadListAdapter.list();
  ok("delete() removes the thread from list()", afterDelete.threads.length === 7, afterDelete.threads.length);
  ok(
    "knownThreadIds() reflects the same 7 seeded ids after delete",
    knownThreadIds().length === 7,
    knownThreadIds(),
  );

  const stream = await fixtureThreadListAdapter.generateTitle("status-glyph-fix", []);
  ok(
    "generateTitle() resolves to something stream-shaped (has getReader)",
    typeof (stream as unknown as { getReader?: unknown }).getReader === "function",
  );

  resetFixtureThreads();
}

async function scenarioHistory(): Promise<void> {
  section("Scenario 4: per-thread ThreadHistoryAdapter round-trip");
  resetAllHistory();
  const history = createHistoryAdapter("history-test-thread");

  const empty = await history.load();
  ok("a fresh thread's history loads empty", empty.messages.length === 0, empty.messages.length);

  const item = {
    parentId: null,
    message: { id: "msg-1", role: "user", content: [{ type: "text", text: "hello" }] } as any,
  };
  await history.append(item);
  const afterAppend = await history.load();
  ok("append() is visible in the next load()", afterAppend.messages.length === 1, afterAppend.messages.length);

  const otherThreadHistory = createHistoryAdapter("history-test-thread-2");
  const otherLoad = await otherThreadHistory.load();
  ok(
    "a DIFFERENT thread's history is isolated (doesn't see the first thread's message)",
    otherLoad.messages.length === 0,
    otherLoad.messages.length,
  );
}

async function scenarioHighlightAndStatus(): Promise<void> {
  section("Scenario 5: highlight.ts pre-warm + status.ts/diffStatus.ts pure logic");
  const html = highlightToHtml("const x = 1;", "typescript", "github-dark-default");
  ok(
    "highlightToHtml resolves synchronously post-warm and returns real markup",
    typeof html === "string" && html.includes("<pre") && html.length > 20,
    html.slice(0, 60),
  );

  const tokens = highlightToTokens("const x = 1;", "typescript", "vesper");
  ok(
    "highlightToTokens resolves synchronously post-warm and returns tokens",
    Array.isArray(tokens.tokens) && tokens.tokens.length > 0,
    tokens.tokens?.length,
  );

  ok("diffPanelBorderStatus(success) === dim", diffPanelBorderStatus("success") === "dim");
  ok("diffPanelBorderStatus(error) === err", diffPanelBorderStatus("error") === "err");
  ok("diffPanelBorderStatus(unknown) === warn", diffPanelBorderStatus("unknown") === "warn");
  ok("liveBulletStatus(pending) === dim", liveBulletStatus(true, false) === "dim");
  ok("liveBulletStatus(error) === err", liveBulletStatus(false, true) === "err");
  ok("liveBulletStatus(ok) === ok", liveBulletStatus(false, false) === "ok");

  const changes = countChanges("--- a/f\n+++ b/f\n+line one\n-line two\n+line three\n");
  ok(
    "countChanges counts + / - lines, ignoring the +++/--- header",
    changes.additions === 2 && changes.deletions === 1,
    changes,
  );
}

async function main(): Promise<void> {
  await scenarioGrantedPath();
  await scenarioDeniedPath();
  await scenarioThreadList();
  await scenarioHistory();
  await scenarioHighlightAndStatus();

  console.log(`\n${assertions - failures}/${assertions} assertions passed.`);
  if (failures > 0) {
    console.error(`\nverify-headless: FAILED (${failures} failing assertion${failures === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nverify-headless: PASSED");
}

main().catch((err) => {
  console.error("verify-headless: uncaught error", err);
  process.exit(1);
});
