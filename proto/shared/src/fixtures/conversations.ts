// LIA-496 — the 7 seeded threads' full scripted conversations. Thread 1
// ("status-glyph-fix") reuses LIA-495's proven "clean up that stale
// scratch log / tighten the status-glyph comment" flow verbatim for its
// first two user turns, then adds a THIRD turn (new for LIA-496) that
// requests a second, different `delete_file` action — this is the
// concrete fixture the grant-store proof needs: if the human picked
// "Always allow" in turn 1, turn 3's tool-call is built with NO `approval`
// field at all, so no PermissionCard/PermissionPrompt renderer ever fires
// for it. Threads 2-7 are shorter, single-turn, real on-topic content
// (each grounded in an actual file/behavior from this same LIA-496 build —
// not lorem ipsum).
import type { ChatModelRunResult, ThreadAssistantMessagePart } from "@assistant-ui/core";
import { sleep, streamTextPart, type EditDiffResult, type ResolvedApproval, type ThreadScript } from "../stream";
import {
  PERMISSION_OPTIONS,
  executionOutcomes,
  grant,
  hasGrant,
  performDelete,
  permissionKey,
} from "../permissions";
import { existsSync, writeFileSync } from "../virtualFs";

// ---------------------------------------------------------------------------
// Thread 1 — "Status-glyph rendering fix": fixture constants, ported
// verbatim from LIA-495's runtime/fixtures.ts for the first two turns,
// extended with a second stale-file path for turn 3.
// ---------------------------------------------------------------------------
const SCRATCH_PATH = "/tmp/deus-shell-scratch.log";
const EDIT_PATH = "src/cli/tui-v2/components/messages/ToolMessage.tsx";
const CHECK_COMMAND = `ls -la ${SCRATCH_PATH}`;
const VERIFY_COMMAND = "ls /tmp | grep deus";

// New for LIA-496 (turn 3, the grant-store proof): a SECOND stale file that
// deliberately does NOT match turn 2's `grep deus` pattern — that's the
// in-fixture reason turn 2 could honestly say "all clean" while this one
// was still sitting there, discovered only when the user brings it up in
// turn 3.
const SECOND_SCRATCH_PATH = "/tmp/tui-v2-auth-debug.log";
const SECOND_CHECK_COMMAND = `ls -la ${SECOND_SCRATCH_PATH}`;

if (!existsSync(SCRATCH_PATH)) {
  writeFileSync(SCRATCH_PATH, "LIA-493 full-shell scratch fixture\n");
}
if (!existsSync(SECOND_SCRATCH_PATH)) {
  writeFileSync(SECOND_SCRATCH_PATH, "stale tui-v2 auth-debug dump, pre-LIA-495\n");
}

// Identical patch text to LIA-495's STATUS_GLYPH_PATCH.
const STATUS_GLYPH_PATCH = `--- a/src/cli/tui-v2/components/messages/ToolMessage.tsx
+++ b/src/cli/tui-v2/components/messages/ToolMessage.tsx
@@ -12,7 +12,9 @@ export function statusGlyph(
 ) {
   switch (status) {
     case "success":
-      return { glyph: "OK", color: "green" };
+      return { glyph: "⏺", color: "semantic.success" };
     case "error":
-      return { glyph: "ERR", color: "red" };
+      return { glyph: "⏺", color: "semantic.error" };
     case "unknown":
-      return { glyph: "?", color: "gray" };
+      return { glyph: "⏺", color: "text.muted" };
   }
 }
`;

// ---------------------------------------------------------------------------
// Shared helpers for the delete_file permission dance — the piece the
// grant store plugs into.
// ---------------------------------------------------------------------------
function buildDeleteToolCallPart(
  toolCallId: string,
  path: string,
  granted: boolean,
): ThreadAssistantMessagePart {
  const base = {
    type: "tool-call" as const,
    toolCallId,
    toolName: "delete_file",
    args: { path },
    argsText: JSON.stringify({ path }),
  };
  if (granted) return base as ThreadAssistantMessagePart;
  return {
    ...base,
    approval: { id: `appr-${toolCallId}`, options: PERMISSION_OPTIONS },
  } as ThreadAssistantMessagePart;
}

// Deliberately does NOT set `result` on the tool-call part (see
// permissions.ts's header comment: threading delete_file's outcome through
// `result` races `respondToApproval`'s own auto-continuation trigger).
// The real, observed outcome is recorded in `executionOutcomes` only.
function applyDelete(toolCallId: string, path: string, approved: boolean): void {
  const ok = approved ? performDelete(path) : false;
  executionOutcomes.set(toolCallId, ok);
}

// ---------------------------------------------------------------------------
// Turn 1 — check + request permission to delete SCRATCH_PATH. Ported
// verbatim from LIA-495's turn1Start/turn1Continue, refactored only to
// route the delete request through `buildDeleteToolCallPart` (so the SAME
// grant-check codepath thread 1 and thread-1-turn-3 both use is exercised
// here too — always false on a genuinely fresh session, but correct rather
// than assumed-false).
// ---------------------------------------------------------------------------
async function* appendCleanupAndClose(
  parts: ThreadAssistantMessagePart[],
  approved: boolean,
): AsyncGenerator<ChatModelRunResult> {
  parts.push({ type: "text", text: "" });
  const intro = approved
    ? "Done — that's cleaned up. Now tightening the status-glyph comment in ToolMessage.tsx."
    : "Understood, I'll leave that file alone. Still tightening the status-glyph comment in ToolMessage.tsx.";
  for await (const snap of streamTextPart(parts, intro)) {
    yield { content: snap };
  }
  await sleep(220);

  parts.push({
    type: "tool-call",
    toolCallId: "call-edit-toolmessage",
    toolName: "Edit",
    args: { path: EDIT_PATH },
    argsText: JSON.stringify({ path: EDIT_PATH }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(620);

  const editResult: EditDiffResult = { type: "diff", diffContent: STATUS_GLYPH_PATCH, filename: EDIT_PATH };
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: editResult, isError: false };
  yield { content: [...parts] };
  await sleep(220);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "That's both done. Let me know if you'd like anything else.")) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

async function* turn1Start(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "reasoning", text: "" }];

  for await (const snap of streamTextPart(
    parts,
    "Two asks here: clean up a stale scratch file, and tighten a status-glyph comment. Deleting a file is destructive, so I should confirm it actually exists before proposing anything — and either way I'll need explicit permission before removing it.",
    "reasoning",
  )) {
    yield { content: snap };
  }
  await sleep(180);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "I'll handle both of those. Let me first check on that scratch file.")) {
    yield { content: snap };
  }
  await sleep(220);

  parts.push({
    type: "tool-call",
    toolCallId: "call-check-scratch",
    toolName: "Bash",
    args: { command: CHECK_COMMAND },
    argsText: JSON.stringify({ command: CHECK_COMMAND }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(480);

  const checkResult = existsSync(SCRATCH_PATH)
    ? `-rw-r--r--  1 deus  staff  36 ${SCRATCH_PATH}`
    : "ls: no such file";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: checkResult, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "Found it — deleting it is a filesystem write, so I need your OK first.")) {
    yield { content: snap };
  }
  await sleep(200);

  const granted = hasGrant(permissionKey("delete_file"));
  parts.push(buildDeleteToolCallPart("call-delete-scratch", SCRATCH_PATH, granted));

  if (!granted) {
    // reason: "tool-calls" (not "interrupt") — this is what lets
    // respondToApproval's shouldContinue check auto-resume this same turn
    // once the human decides, with no second user message needed.
    yield { content: [...parts], status: { type: "requires-action", reason: "tool-calls" } };
    return;
  }

  // Grant store already has this permission (e.g. exercised directly by
  // the headless verification script) — apply inline, same run() call, no
  // approval round-trip and nothing rendered for it.
  applyDelete("call-delete-scratch", SCRATCH_PATH, true);
  yield* appendCleanupAndClose(parts, true);
}

async function* turn1Continue(approval: ResolvedApproval): AsyncGenerator<ChatModelRunResult> {
  if (approval.optionId === "allow_always") grant(permissionKey("delete_file"));
  applyDelete("call-delete-scratch", SCRATCH_PATH, approval.approved);
  yield* appendCleanupAndClose([], approval.approved);
}

// ---------------------------------------------------------------------------
// Turn 2 — "Did that leave anything else stale in /tmp?" Ported verbatim
// from LIA-495's turn2.
// ---------------------------------------------------------------------------
async function* turn2(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];

  for await (const snap of streamTextPart(parts, "Checking now.")) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: `call-verify-${Date.now()}`,
    toolName: "Bash",
    args: { command: VERIFY_COMMAND },
    argsText: JSON.stringify({ command: VERIFY_COMMAND }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(480);

  const remaining = existsSync(SCRATCH_PATH);
  const verifyResult = remaining ? SCRATCH_PATH.split("/").pop()! : "(no matches)";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: verifyResult, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  const closing = remaining
    ? "There's still one leftover file there from the earlier denial — otherwise clean."
    : "All clean by that pattern — nothing matching `deus` left in /tmp.";
  for await (const snap of streamTextPart(parts, closing)) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

// ---------------------------------------------------------------------------
// Turn 3 — NEW for LIA-496: a second, unrelated stale file, deliberately
// missed by turn 2's grep because it doesn't match the `deus` prefix. This
// is the grant-store proof: when `delete_file` was already granted in
// turn 1, this request is built and applied with NO approval field at
// all — nothing for a PermissionCard/PermissionPrompt renderer to key off,
// so no prompt renders. When it wasn't granted (denied, or only
// allow_once'd), this behaves exactly like turn 1 did: a normal pending
// approval, resolved by `turn3Continue`.
// ---------------------------------------------------------------------------
async function* turn3Start(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "reasoning", text: "" }];

  for await (const snap of streamTextPart(
    parts,
    "Another stale file, same deletion risk as the last one — worth confirming it's actually there before proposing anything.",
    "reasoning",
  )) {
    yield { content: snap };
  }
  await sleep(160);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "Checking for that one now.")) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: "call-check-second",
    toolName: "Bash",
    args: { command: SECOND_CHECK_COMMAND },
    argsText: JSON.stringify({ command: SECOND_CHECK_COMMAND }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(420);

  const checkResult2 = existsSync(SECOND_SCRATCH_PATH)
    ? `-rw-r--r--  1 deus  staff  58 ${SECOND_SCRATCH_PATH}`
    : "ls: no such file";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: checkResult2, isError: false };
  yield { content: [...parts] };
  await sleep(180);

  const granted = hasGrant(permissionKey("delete_file"));
  parts.push({ type: "text", text: "" });
  const askText = granted
    ? "Found it — and since you already said always-allow deletions this session, I'll clear it without asking again."
    : "Found it. Same kind of destructive action as before, so I need your OK again.";
  for await (const snap of streamTextPart(parts, askText)) {
    yield { content: snap };
  }
  await sleep(180);

  parts.push(buildDeleteToolCallPart("call-delete-second", SECOND_SCRATCH_PATH, granted));

  if (!granted) {
    yield { content: [...parts], status: { type: "requires-action", reason: "tool-calls" } };
    return;
  }

  applyDelete("call-delete-second", SECOND_SCRATCH_PATH, true);
  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "Cleared — that's the last of the stale files in /tmp.")) {
    yield { content: snap };
  }
  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

async function* turn3Continue(approval: ResolvedApproval): AsyncGenerator<ChatModelRunResult> {
  applyDelete("call-delete-second", SECOND_SCRATCH_PATH, approval.approved);
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];
  const closing = approval.approved
    ? "Cleared — that's the last of the stale files in /tmp."
    : "Understood, I'll leave that one alone too.";
  for await (const snap of streamTextPart(parts, closing)) {
    yield { content: snap };
  }
  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

async function* unscripted(): AsyncGenerator<ChatModelRunResult> {
  yield { content: [], status: { type: "complete", reason: "stop" } };
}

// Fallback for a thread id not present in SCRIPTS below — a genuinely new
// thread the user started via the sidebar's "New thread" affordance, which
// `FixtureThreadListAdapter.initialize` (threadList.ts) registers but this
// fixture has no canned conversation for. An honest fake (§ Feature scope)
// rather than a crash: says plainly that this is a scripted spike and
// points back at the seeded threads, instead of pretending to be a real
// model.
async function* genericNewThreadTurn(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];
  for await (const snap of streamTextPart(
    parts,
    "This is a scripted fixture spike (LIA-496) — new threads don't have a canned conversation. Switch to one of the seeded threads in the sidebar to see the full streaming / tool-call / permission flow.",
  )) {
    yield { content: snap };
  }
  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

const genericNewThreadScript: ThreadScript = {
  start(turnIndex) {
    if (turnIndex === 1) return genericNewThreadTurn();
    return unscripted();
  },
  continuations: {},
};

const statusGlyphFixScript: ThreadScript = {
  start(turnIndex) {
    if (turnIndex === 1) return turn1Start();
    if (turnIndex === 2) return turn2();
    if (turnIndex === 3) return turn3Start();
    return unscripted();
  },
  continuations: {
    "call-delete-scratch": turn1Continue,
    "call-delete-second": turn3Continue,
  },
};

// ---------------------------------------------------------------------------
// Threads 2-6 — single-turn, no permission interrupt, real on-topic
// content grounded in actual files/behavior from this same LIA-496 build.
// ---------------------------------------------------------------------------
type SimpleTurnSpec = {
  reasoning?: string;
  intro: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  closing: string;
};

async function* simpleToolCallTurn(spec: SimpleTurnSpec): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [];

  if (spec.reasoning) {
    parts.push({ type: "reasoning", text: "" });
    for await (const snap of streamTextPart(parts, spec.reasoning, "reasoning")) {
      yield { content: snap };
    }
    await sleep(160);
  }

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, spec.intro)) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: spec.toolCallId,
    toolName: spec.toolName,
    args: spec.args,
    argsText: JSON.stringify(spec.args),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(480);

  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: spec.result, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, spec.closing)) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

// S2A (web) deviation: `start(turnIndex)` used to fall straight to
// `unscripted()` for any turnIndex beyond 1 — which is exactly what a
// second `run()` call on the SAME thread produces, and Reload
// (ActionBarPrimitive.Reload, see web-app/src/components/ActionBar.tsx)
// IS a second `run()` call: confirmed live (Playwright against the real
// dev server) that clicking Reload on a single-turn fixture thread's
// message replaced it with a genuinely EMPTY assistant response. That
// directly contradicts this dispatch's own Feature-scope line: "Reload
// re-invokes the real adapter, which returns a scripted VARIANT on
// re-run — the mechanism is real and only the model is scripted." An
// empty response on regenerate is not an honest fake, it's broken. Fixed
// here, shared-side (not a web-only workaround, since Ink's ActionBar
// equivalent re-invokes the same `getFixtureAdapter` and would hit the
// identical gap): turnIndex 2 replays the SAME tool call from scratch
// (proving the mechanism is real, not a frozen replay) with a visibly
// different closing line, so a regenerate is observably a NEW generation.
// turnIndex 3+ still falls to `unscripted()` — a second reload isn't part
// of this spike's demoed flow.
function simpleScript(spec: SimpleTurnSpec): ThreadScript {
  return {
    start(turnIndex) {
      if (turnIndex === 1) return simpleToolCallTurn(spec);
      if (turnIndex === 2) {
        return simpleToolCallTurn({
          ...spec,
          closing: `${spec.closing} (regenerated — same result on a fresh pass, nothing new to add.)`,
        });
      }
      return unscripted();
    },
    continuations: {},
  };
}

const composerShortcutsScript = simpleScript({
  reasoning:
    "Cmd+Enter to submit and Escape to blur are standard composer affordances — I can wire both directly in the keydown handler without touching the pill styling.",
  intro: "I'll wire the keydown handler in the composer component.",
  toolCallId: "call-edit-composer",
  toolName: "Edit",
  args: { path: "web-app/src/components/Composer.tsx" },
  result: {
    type: "diff",
    filename: "web-app/src/components/Composer.tsx",
    diffContent: `--- a/web-app/src/components/Composer.tsx
+++ b/web-app/src/components/Composer.tsx
@@ -18,6 +18,15 @@ export function Composer() {
   const composer = useComposerRuntime();

+  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
+    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
+      event.preventDefault();
+      composer.send();
+      return;
+    }
+    if (event.key === "Escape") {
+      event.currentTarget.blur();
+    }
+  };
+
   return (
`,
  } satisfies EditDiffResult,
  closing: "Done — Cmd+Enter submits, Escape blurs the pill composer. Try it out.",
});

const lia495MigrationSpikeScript = simpleScript({
  reasoning: "The honest answer is in the import line, not in anything I'd have to explain — let me just show it.",
  intro: "Quick recap — checking the actual import.",
  toolCallId: "call-grep-adapter-import",
  toolName: "Bash",
  args: {
    command:
      'grep -n "@assistant-ui/core" ../lia495-assistant-ui-adoption/proto/web-first-demo/src/runtime/adapter.ts',
  },
  result:
    '11:import type { ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react";\n12:import type { ThreadAssistantMessagePart } from "@assistant-ui/core";',
  closing:
    "There's your answer — ChatModelAdapter/ChatModelRunResult/ThreadAssistantMessagePart are all defined once in @assistant-ui/core and re-exported unchanged by both @assistant-ui/react and @assistant-ui/react-ink, so LIA-495's turn generators needed zero logic changes to run on web. LIA-496 goes one step further and imports straight from @assistant-ui/core in the shared package, so it's genuinely one file instead of two copies that only differ by import specifier.",
});

const sidebarLayoutPassScript = simpleScript({
  reasoning:
    "ThreadListPrimitive doesn't expose a groupBy prop — confirmed by reading its .d.ts, it's exactly Root/Items/ItemByIndex/LoadMore/New — so Today/Yesterday has to be manual filtering over lastMessageAt in the sidebar component itself.",
  intro: "I'll widen the rail and add the two date-bucket headers.",
  toolCallId: "call-edit-sidebar",
  toolName: "Edit",
  args: { path: "web-app/src/components/Sidebar.tsx" },
  result: {
    type: "diff",
    filename: "web-app/src/components/Sidebar.tsx",
    diffContent: `--- a/web-app/src/components/Sidebar.tsx
+++ b/web-app/src/components/Sidebar.tsx
@@ -4,7 +4,7 @@
 import { ThreadListPrimitive } from "@assistant-ui/react";

-const RAIL_WIDTH = "224px";
+const RAIL_WIDTH = "272px";

+function groupByDay(items: ThreadListItemState[]) {
+  const today: ThreadListItemState[] = [];
+  const yesterday: ThreadListItemState[] = [];
+  const now = new Date();
+  for (const item of items) {
+    (isSameCalendarDay(item.lastMessageAt, now) ? today : yesterday).push(item);
+  }
+  return { today, yesterday };
+}
+
   export function Sidebar() {
`,
  } satisfies EditDiffResult,
  closing: "Widened the rail to 272px and split the list into Today/Yesterday sections.",
});

const diffPanelPolishScript = simpleScript({
  reasoning:
    "If the filename is both the diff card's own header AND baked into the diff text's +++ line, that's the same fact rendered twice — LIA-495's FINDINGS.md already names this exact bug once.",
  intro: "I'll drop the header's duplicate filename line and let the diff card supply it once.",
  toolCallId: "call-edit-diffpanel",
  toolName: "Edit",
  args: { path: "web-app/src/components/DiffPanel.tsx" },
  result: {
    type: "diff",
    filename: "web-app/src/components/DiffPanel.tsx",
    diffContent: `--- a/web-app/src/components/DiffPanel.tsx
+++ b/web-app/src/components/DiffPanel.tsx
@@ -22,8 +22,6 @@ export function DiffPanel({ diff }: { diff: EditDiffResult }) {
   return (
     <div className="diff-card">
-      <div className="diff-card-header">{diff.filename}</div>
-      <div className="diff-card-header">{diff.filename}</div>
+      <div className="diff-card-header">{diff.filename}</div>
       <RawDiffLines diffContent={diff.diffContent} />
     </div>
`,
  } satisfies EditDiffResult,
  closing: "Fixed — the card header is now the only place the filename shows.",
});

const streamingMarkdownFlickerScript = simpleScript({
  reasoning:
    "A flash of unstyled code during streaming means the highlighter wasn't warm yet on first render — shiki's per-call async shorthand functions would explain exactly that.",
  intro: "Checking whether the singleton is actually pre-warmed before either app mounts.",
  toolCallId: "call-grep-prewarm",
  toolName: "Bash",
  args: { command: "grep -n getSingletonHighlighter shared/src/highlight.ts" },
  result: "60:const highlighter: Highlighter = await getSingletonHighlighter({ langs: LANGS });",
  // S2A (web) deviation: this closing text now contains a fenced ```typescript
  // block (it didn't before) — the ONLY place across all seeded fixtures
  // that puts a real fenced code block through an assistant text part.
  // MarkdownText.tsx -> CodeBlock.tsx is a hard-required consuming call
  // site (S1 dispatch's "Consuming call sites" section flags it as the
  // link a prior review round found missing), and no fixture content
  // actually exercised it: every other script's inline `code` uses single
  // backticks (inline code), and DiffPanel/Edit-tool results go through
  // the diff card, never markdown. Routed through this one real
  // shared-side content edit rather than fabricating web-only fixture
  // text, so both targets' Markdown/CodeBlock renderers get the same real
  // exercise. Content is the actual highlightToHtml wrapper, byte-matching
  // shared/src/highlight.ts — not lorem.
  closing:
    'Confirmed — shared/src/highlight.ts has a top-level await that warms the singleton and loads both targets\' themes before either app renders a frame, so highlightToHtml/highlightToTokens are synchronous by the time any component calls them. No flicker to fix here; it was already closed by the pre-warm. For reference, this is the wrapper both targets call:\n\n```typescript\nexport function highlightToHtml(\n  code: string,\n  lang: BundledLanguage,\n  theme: BundledTheme,\n): string {\n  return highlighter.codeToHtml(code, { lang, theme });\n}\n```',
});

// ---------------------------------------------------------------------------
// S2A (web) deviation, new thread for LIA-496: "theme-swap-crash" — the one
// fixture thread scripted to throw from the adapter (§ Feature scope; also
// named explicitly in the S1 dispatch's "Consuming call sites" section as
// ErrorState.tsx's/ErrorPrimitive's required consumer). No seeded thread did
// this before S2A. Mechanism verified by reading
// node_modules/@assistant-ui/core/dist/runtimes/local/
// local-thread-runtime-core.js:371-386 directly: a `run()` generator that
// throws is caught by LocalThreadRuntimeCore and turned into
// `message.status = { type: "incomplete", reason: "error", error:
// toAssistantError(e) }` — exactly what @assistant-ui/core's
// `useMessageError()` (which ErrorPrimitive.Message calls) reads. This is a
// REAL thrown JS Error, not a special-cased "fake error part" — the same
// path a genuine adapter failure would take. Grounded in an actual shiki
// fact (loadTheme throws for a theme name outside the loaded bundle), not
// lorem.
// ---------------------------------------------------------------------------
async function* themeSwapCrashTurn1(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "reasoning", text: "" }];
  for await (const snap of streamTextPart(
    parts,
    "Loading an alternate theme to compare against vesper before deciding whether Transcript should default to it.",
    "reasoning",
  )) {
    yield { content: snap };
  }
  await sleep(160);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "Let me check the loadTheme call site first.")) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: "call-grep-loadtheme",
    toolName: "Bash",
    args: { command: "grep -n loadTheme shared/src/highlight.ts" },
    argsText: JSON.stringify({ command: "grep -n loadTheme shared/src/highlight.ts" }),
  } as ThreadAssistantMessagePart);
  yield { content: [...parts] };
  await sleep(300);

  parts[parts.length - 1] = {
    ...(parts[parts.length - 1] as any),
    result: "88:  await highlighter.loadTheme(theme);",
    isError: false,
  };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(parts, "Now trying the alternate theme directly.")) {
    yield { content: snap };
  }
  await sleep(160);

  // Real throw — NOT a scripted error tool-call result. Propagates out of
  // this generator; local-thread-runtime-core.js's catch converts it to
  // message.status = {type:"incomplete", reason:"error", ...} (see this
  // block's header comment for the exact source lines).
  throw new Error(
    'shiki: unbundled theme "solarized-dusk" is not part of the loaded bundle — call highlighter.loadTheme() with a name from bundledThemes first',
  );
}

const themeSwapCrashScript: ThreadScript = {
  start(turnIndex) {
    if (turnIndex === 1) return themeSwapCrashTurn1();
    return unscripted();
  },
  continuations: {},
};

export const SCRIPTS: Record<string, ThreadScript> = {
  "status-glyph-fix": statusGlyphFixScript,
  "composer-shortcuts": composerShortcutsScript,
  "lia495-migration-spike": lia495MigrationSpikeScript,
  "sidebar-layout-pass": sidebarLayoutPassScript,
  "diff-panel-polish": diffPanelPolishScript,
  "streaming-markdown-flicker": streamingMarkdownFlickerScript,
  "theme-swap-crash": themeSwapCrashScript,
};

// Used by adapter.ts instead of a raw `SCRIPTS[threadId]` lookup so a
// freshly-initialized thread not in the 7 seeded ids gets the honest
// fallback above instead of a thrown error.
export function getScriptForThread(threadId: string): ThreadScript {
  return SCRIPTS[threadId] ?? genericNewThreadScript;
}
