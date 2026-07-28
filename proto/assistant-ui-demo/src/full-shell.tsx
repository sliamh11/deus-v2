// LIA-493 prototype — round 4: the FULL Claude Code app-shell, composed.
//
// Prior rounds (see FINDINGS.md) redesigned two ISOLATED screens
// (permission-screen.tsx, diff-screen.tsx) to the shared Claude Code
// design-language spec. This file is a different kind of artifact: one
// real, runnable @assistant-ui/react-ink application that hosts an entire
// scripted-but-live session end to end — header, spinner, streamed
// multi-turn transcript, a tool call with a diff, an INLINE permission
// interrupt that pauses and resumes the same flow, and a footer — so the
// wayfinder comparison (LIA-492) has one genuine "can this library host a
// full session" data point, not just fragments.
//
// Reused/mirrored from the round-3 screens rather than reinvented:
//   - tokens / BULLET / oscHyperlink / pathHyperlink / ToolPath — copied
//     verbatim from permission-screen.tsx (same shared design tokens).
//   - PERMISSION_OPTIONS / decisionFromOptionId / the PermissionToolUI
//     cursor-loop shape / ResolvedRow's stateful-⏺-from-observed-outcome
//     convention — mirrored from permission-screen.tsx, trimmed to this
//     file's single delete_file interrupt (the exhaustive allow-once /
//     always-allow / deny walkthrough already lives in permission-screen.tsx
//     — duplicating it here would be scope creep, not scope completion).
//   - DiffPanel / diffPanelBorderColor / assertDiffPanelNeverImpliesSuccess
///    countChanges — mirrored from diff-screen.tsx verbatim.
//
// NEW finding this round (verified by reading @assistant-ui/core's actual
// runtime source AND by instrumenting a live tmux run with timestamped
// logs, not assumed): local-thread-runtime-core.js's `respondToToolApproval`
// re-invokes the adapter's `run()` automatically after a decision — but
// only if `shouldContinue()` (should-continue.js) sees the MESSAGE-level
// status as `{type:"requires-action", reason:"tool-calls"}`. Round 3's
// permission-screen.tsx used `reason:"interrupt"` (per the spec's literal
// example), which `shouldContinue` explicitly excludes
// (`reason !== "tool-calls" → false`) — that is *why* that screen needed a
// second, separate user message to demonstrate its follow-up auto-grant.
// Using `reason:"tool-calls"` here instead lets the SAME scripted turn
// genuinely pause for approval and then resume on its own — no fake second
// user message needed — which is what "the conversation continuing after"
// in the brief actually calls for. `unstable_getMessage()`
// (ChatModelRunOptions) is the mechanism the continued `run()` invocation
// uses to see the just-resolved tool-call and branch accordingly, since
// `options.messages` on that re-invocation is unchanged (it's keyed off the
// ORIGINAL parent, not the in-progress assistant message).
//
// A second, sharper finding surfaced only by RUNNING this (a live tmux
// crash, not a hypothetical): `shouldContinue`'s per-part gate is
// `result === undefined && approval !== undefined && approval.approved ===
// undefined` — note it only excludes a tool-call while its approval is
// STILL unresolved. The instant `respondToApproval` sets `approval.approved`,
// that gate no longer matches, `shouldContinue` returns true, and
// `_runLoop`'s synchronous prefix (calling `performRoundtrip`, which sets
// `this.abortController = new AbortController()` before its first `await`)
// runs to completion INSIDE the same synchronous call to `respondToApproval`
// — before it even returns. A first draft of this file called
// `props.addResult(...)` (to record the real deletion outcome) immediately
// followed by `props.respondToApproval(...)`: `addResult` alone already
// satisfies the same gate (it sets `result`, independently defeating the
// `result === undefined` check), so it ALSO synchronously kicks off the
// continuation and sets `abortController` — and the very next line's
// `respondToApproval` call then throws "Tried to respond to a tool approval
// while a run is in progress", confirmed via timestamped debug logs
// (`confirm(): addResult called` immediately followed by a re-entrant
// `adapter.run: ENTER` and then the throw, all within the same
// millisecond). Fix: never call `addResult` for a tool-call whose approval
// is still pending. This screen tracks the real, synchronously-observed
// deletion outcome in a plain `executionOutcomes` map instead (identical
// approach to permission-screen.tsx's own, already-verified pattern) and
// only ever calls `respondToApproval` — the one call that's actually
// supposed to trigger the continuation.
//
// Packaging note: the round-3 `assistant-cloud` stub
// (node_modules/assistant-cloud/, git-force-added, see FINDINGS.md) already
// unblocks the package's PUBLIC barrel — verified live in this session by
// importing DiffView from the bare `@assistant-ui/react-ink` specifier
// successfully, so this file (unlike diff-screen.tsx) does not need the
// internal `dist/primitives/diff/DiffView.js` deep-import workaround.
import { render, Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  LoadingPrimitive,
  useAssistantToolUI,
  useAuiState,
  DiffView,
  type ChatModelAdapter,
  type ChatModelRunResult,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react-ink";
import type {
  ToolApprovalOption,
  ToolApprovalResponse,
  ThreadAssistantMessagePart,
} from "@assistant-ui/core";

// ---------------------------------------------------------------------------
// Shared Claude Code design-language tokens (cc-design-spec.md § Color
// system). Copied verbatim from permission-screen.tsx / diff-screen.tsx —
// duplicating the literal hex values rather than importing them, since those
// files are standalone entry points (each calls `render()` at module scope)
// and importing from them would re-run their own fixtures/side effects.
// ---------------------------------------------------------------------------
const tokens = {
  textMuted: "#B0AEA5",
  textPrimary: "#FAF9F5",
  accentPrimary: "#D97757",
  accentInfo: "#6A9BCC",
  semanticSuccess: "#788C5D",
  semanticWarning: "#C49A52",
  semanticError: "#B95C50",
  borderNeutral: "#B0AEA5",
} as const;

// The single stateful glyph — never swapped for ✓/✗/? (spec: "do not switch
// between unrelated success/error glyph families").
const BULLET = "⏺";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// OSC 8 path hyperlink helper — identical contract to permission-screen.tsx.
// ---------------------------------------------------------------------------
const OSC8_ESC = "";
const OSC8_BEL = "";

function oscHyperlink(url: string, label: string): string {
  return `${OSC8_ESC}]8;;${url}${OSC8_BEL}${label}${OSC8_ESC}]8;;${OSC8_BEL}`;
}

function pathHyperlink(rawPath: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolvePath(process.cwd(), rawPath);
  return oscHyperlink(`file://${encodeURI(abs)}`, rawPath);
}

const ToolPath: React.FC<{ path: string }> = ({ path }) => (
  <Text color={tokens.accentInfo}>{pathHyperlink(path)}</Text>
);

function extractPath(args: unknown): string | undefined {
  if (args && typeof args === "object" && "path" in (args as Record<string, unknown>)) {
    const p = (args as { path?: unknown }).path;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rotating-gerund spinner (spec § Spinner and active status). Confirmed
// examples reused verbatim from the spec, not a generic "Loading...". The
// spinner glyph itself comes from the library's own LoadingPrimitive.Spinner
// (ink-spinner "dots" under the hood) — only the rotating word is hand-rolled,
// since the library has no word-rotation primitive.
// ---------------------------------------------------------------------------
const GERUND_WORDS = [
  "Pondering",
  "Percolating",
  "Cogitating",
  "Ruminating",
  "Deliberating",
  "Musing",
  "Inferring",
  "Deciphering",
] as const;

function useRotatingGerund(intervalMs = 950): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % GERUND_WORDS.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return GERUND_WORDS[i]!;
}

const ActiveStatusRow: React.FC = () => {
  const word = useRotatingGerund();
  return (
    <Box marginBottom={1}>
      <Text color={tokens.accentPrimary}>
        <LoadingPrimitive.Spinner type="dots" />
      </Text>
      <Text color={tokens.accentPrimary}> {word}…</Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Header / status bar — session identifier + a subtle (non-animated) status
// word. The animated spinner treatment lives in the transcript itself
// (ActiveStatusRow, per spec: use the rotating-gerund treatment only while
// actively working); the header just names the current phase.
// ---------------------------------------------------------------------------
function useShellStatus(): "idle" | "working" | "awaiting approval" {
  return useAuiState((s) => {
    if (s.thread.isRunning) return "working";
    const lastAssistant = [...s.thread.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.role === "assistant" && lastAssistant.status?.type === "requires-action") {
      return "awaiting approval";
    }
    return "idle";
  });
}

const Header: React.FC = () => {
  const status = useShellStatus();
  const color =
    status === "working" ? tokens.accentPrimary : status === "awaiting approval" ? tokens.semanticWarning : tokens.textMuted;
  const label = status === "working" ? "Working" : status === "awaiting approval" ? "Awaiting approval" : "Idle";
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderNeutral}
      marginBottom={1}
    >
      <Text bold color={tokens.textPrimary}>
        deus-v2-mvp
      </Text>
      <Text color={tokens.textMuted}> · full-shell-demo (LIA-493) · </Text>
      <Text color={color}>
        {BULLET} {label}
      </Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Diff panel — mirrored verbatim from diff-screen.tsx's DiffPanel (same
// canonical shape: OSC 8 path + compact +/- counts above a rounded panel;
// a non-success status gets an explicit "Proposed changes — not applied"
// label and a warning/error border rather than the neutral one).
// ---------------------------------------------------------------------------
type ToolCallStatus = "success" | "error" | "unknown";

function diffPanelBorderColor(status: ToolCallStatus): string {
  switch (status) {
    case "success":
      return tokens.borderNeutral;
    case "error":
      return tokens.semanticError;
    case "unknown":
      return tokens.semanticWarning;
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled ToolCallStatus: ${_exhaustive}`);
    }
  }
}

function assertDiffPanelNeverImpliesSuccess(): void {
  const nonSuccessStatuses: readonly ToolCallStatus[] = ["error", "unknown"];
  for (const status of nonSuccessStatuses) {
    if (diffPanelBorderColor(status) === tokens.borderNeutral) {
      throw new Error(`regression: DiffPanel border for ToolCallStatus "${status}" resolved to the neutral color`);
    }
  }
}
assertDiffPanelNeverImpliesSuccess();

function countChanges(diffContent: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function DiffPanel({
  diffContent,
  path: relPath,
  status,
}: {
  diffContent: string;
  path?: string;
  status: ToolCallStatus;
}) {
  const { additions, deletions } = countChanges(diffContent);
  const notApplied = status !== "success";
  const borderColor = diffPanelBorderColor(status);
  return (
    <Box flexDirection="column" marginTop={1}>
      {relPath ? (
        <Box marginBottom={1}>
          <ToolPath path={relPath} />
          <Text> </Text>
          <Text color={tokens.semanticSuccess}>+{additions}</Text>
          <Text> </Text>
          <Text color={tokens.semanticError}>-{deletions}</Text>
        </Box>
      ) : null}
      {notApplied ? (
        <Box marginBottom={1}>
          <Text bold color={borderColor}>
            Proposed changes — not applied
          </Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <DiffView patch={diffContent} showLineNumbers contextLines={3} maxLines={30} />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Generic tool-call renderers (Bash, Edit) — canonical
// `⏺ ToolName(args)` line, bullet color carrying pending(gray)/success/error
// state per spec ("bullet transitions from gray while unresolved to green
// after successful completion").
// ---------------------------------------------------------------------------
function liveBulletColor(pending: boolean, isError: boolean): string {
  if (pending) return tokens.textMuted;
  return isError ? tokens.semanticError : tokens.semanticSuccess;
}

const BashToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = liveBulletColor(pending, isError);
  const command = (props.args as { command?: string } | undefined)?.command ?? props.argsText;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text bold>Bash</Text>
        <Text>(</Text>
        <Text color={tokens.textMuted}>{command}</Text>
        <Text>)</Text>
      </Box>
      <Box>
        <Text dimColor={!pending} color={pending ? tokens.textMuted : undefined}>
          {"  "}
          {pending ? "running…" : String(props.result)}
        </Text>
      </Box>
    </Box>
  );
};

type EditDiffResult = { type: "diff"; diffContent: string; filename: string };

const EditToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = liveBulletColor(pending, isError);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text bold>Edit</Text>
        <Text>(</Text>
        {path ? <ToolPath path={path} /> : <Text color={tokens.textMuted}>{props.argsText}</Text>}
        <Text>)</Text>
      </Box>
      {pending ? (
        <Box>
          <Text color={tokens.textMuted}>  editing…</Text>
        </Box>
      ) : (
        (() => {
          const result = props.result as EditDiffResult;
          const status: ToolCallStatus = isError ? "error" : "success";
          return <DiffPanel diffContent={result.diffContent} path={path} status={status} />;
        })()
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Permission chooser (delete_file) — mirrored from permission-screen.tsx,
// trimmed to a single interrupt (allow-once / allow-always / deny is
// already exhaustively covered there; re-proving all three branches here
// would be scope creep against this file's actual job, which is showing the
// interrupt genuinely appearing MID-conversation and the flow resuming).
// Preserves the library-owned data model verbatim: ToolCallMessagePart.
// approval / ToolApprovalOption[] / respondToApproval (props.addResult is
// deliberately NOT used here — see the header comment's second finding).
// ---------------------------------------------------------------------------
type PermissionDecision = "allow_once" | "allow_always" | "deny";

const PERMISSION_OPTIONS: readonly ToolApprovalOption[] = [
  { id: "allow_once", kind: "allow-once", label: "Allow once" },
  { id: "allow_always", kind: "allow-always", label: "Always allow" },
  { id: "deny", kind: "reject-once", label: "Deny" },
];

function decisionFromOptionId(optionId: string | undefined): PermissionDecision | undefined {
  return PERMISSION_OPTIONS.find((o) => o.id === optionId)?.id as PermissionDecision | undefined;
}

function performDelete(targetPath: string): boolean {
  try {
    rmSync(targetPath, { force: false });
    return !existsSync(targetPath);
  } catch {
    return false;
  }
}

const PermissionOptionRow: React.FC<{
  option: ToolApprovalOption;
  index: number;
  selected: boolean;
}> = ({ option, index, selected }) => {
  const rowColor = selected ? tokens.accentPrimary : tokens.textPrimary;
  return (
    <Text color={rowColor}>
      {selected ? "› " : "  "}
      {index + 1}. {option.label ?? option.id}
      {option.kind === "allow-always" && <Text color={tokens.accentInfo}> (persists until revoked)</Text>}
    </Text>
  );
};

// Tracks the REAL, synchronously-observed outcome of each approved deletion,
// keyed by toolCallId — read by ResolvedRow below. Deliberately NOT threaded
// through `props.addResult`/`props.result`: see the header comment's second
// finding for why calling `addResult` on a tool-call whose approval is still
// pending races with `respondToApproval`'s own auto-continuation trigger.
// This is the same map-based approach permission-screen.tsx already uses
// and has verified working end-to-end.
const executionOutcomes = new Map<string, boolean>();

const ResolvedRow: React.FC<{
  approval: NonNullable<ToolCallMessagePartProps["approval"]>;
  options: readonly ToolApprovalOption[];
  toolName: string;
  path: string | undefined;
  argsText: string;
  toolCallId: string;
}> = ({ approval, options, toolName, path, argsText, toolCallId }) => {
  if (approval.resolution) {
    return (
      <Text color={tokens.semanticWarning}>
        {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — request {approval.resolution}, no decision
        made
      </Text>
    );
  }
  const decision = decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
  const label = options.find((o) => o.id === approval.optionId)?.label ?? decision;
  const deleted = executionOutcomes.get(toolCallId);
  const outcomeText = decision === "deny" ? undefined : deleted === undefined ? "awaiting execution" : deleted ? "deleted" : "delete failed";
  const color =
    decision === "deny"
      ? tokens.semanticError
      : deleted === undefined
        ? tokens.semanticWarning
        : deleted
          ? tokens.semanticSuccess
          : tokens.semanticError;
  return (
    <Text color={color}>
      {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — {label}
      {outcomeText ? ` (${outcomeText})` : ""}
    </Text>
  );
};

const PermissionToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  const [cursorIndex, setCursorIndex] = useState(0);
  const approval = props.approval;
  const options = (approval?.options as readonly ToolApprovalOption[] | undefined) ?? PERMISSION_OPTIONS;
  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);
  const path = extractPath(props.args);

  const confirm = (index: number) => {
    const chosen = options[index]!;
    const approved = chosen.kind === "allow-once" || chosen.kind === "allow-always";
    // Perform the real deletion NOW, synchronously, and record its outcome
    // in `executionOutcomes` BEFORE calling respondToApproval — never via
    // `props.addResult` here (see header comment's second finding: calling
    // addResult on a tool-call whose approval is still pending races with
    // respondToApproval's own auto-continuation trigger and throws). This
    // is the ONLY call into the runtime this handler makes.
    if (approved && path) {
      const deleted = performDelete(path);
      executionOutcomes.set(props.toolCallId, deleted);
    }
    props.respondToApproval({ approved, optionId: chosen.id } as ToolApprovalResponse);
  };

  useInput(
    (input, key) => {
      if (resolved) return;
      if (input === "1" || input === "2" || input === "3") {
        const index = Number(input) - 1;
        if (index < options.length) {
          setCursorIndex(index);
          confirm(index);
        }
        return;
      }
      if (key.upArrow) setCursorIndex((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setCursorIndex((i) => (i + 1) % options.length);
      else if (key.return) confirm(cursorIndex);
    },
    { isActive: !resolved },
  );

  if (resolved && approval) {
    return (
      <Box marginBottom={1}>
        <ResolvedRow
          approval={approval}
          options={options}
          toolName={props.toolName}
          path={path}
          argsText={props.argsText}
          toolCallId={props.toolCallId}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.semanticWarning} paddingX={1} marginY={1}>
      <Text bold color={tokens.semanticWarning}>
        Permission required
      </Text>
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>{BULLET} </Text>
        <Text bold color={tokens.textPrimary}>
          {props.toolName}
        </Text>
      </Box>
      <Box>{path ? <ToolPath path={path} /> : <Text color={tokens.textMuted}>{props.argsText}</Text>}</Box>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <PermissionOptionRow key={opt.id} option={opt} index={i} selected={i === cursorIndex} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>↑/↓ move · 1–3 choose · Enter confirm</Text>
      </Box>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Footer — "Current Tasks" pills (spec § Current Tasks footer). Derived from
// REAL, observed progress of this fixture's own three steps (never
// fabricated dependency data, per the brief's explicit warning) by scanning
// the actual thread state for the matching tool calls and their resolution.
// ---------------------------------------------------------------------------
type TaskStatus = "pending" | "active" | "done" | "blocked";

function useToolTaskStatus(toolName: string, matchCommand?: string): TaskStatus {
  return useAuiState((s) => {
    for (const m of s.thread.messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (c.type !== "tool-call" || c.toolName !== toolName) continue;
        if (matchCommand !== undefined) {
          const cmd = (c.args as Record<string, unknown> | undefined)?.command;
          if (cmd !== matchCommand) continue;
        }
        if (c.approval && c.approval.approved === false) return "blocked";
        if (c.result !== undefined) return c.isError ? "blocked" : "done";
        return "active";
      }
    }
    return "pending";
  });
}

// delete_file is the one tool-call in this fixture whose result is
// deliberately never set (see the header comment's second finding — setting
// it via addResult would race respondToApproval's auto-continuation), so
// its task's completion is read from `approval.approved` instead of
// `result`, unlike the generic check above.
function useApprovalTaskStatus(toolName: string): TaskStatus {
  return useAuiState((s) => {
    for (const m of s.thread.messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (c.type !== "tool-call" || c.toolName !== toolName) continue;
        if (!c.approval) return "pending";
        if (c.approval.resolution) return "blocked";
        if (c.approval.approved === undefined) return "active";
        return c.approval.approved ? "done" : "blocked";
      }
    }
    return "pending";
  });
}

function taskPillColor(status: TaskStatus): string {
  switch (status) {
    case "done":
      return tokens.semanticSuccess;
    case "blocked":
      return tokens.semanticError;
    case "active":
      return tokens.accentPrimary;
    case "pending":
      return tokens.textMuted;
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled TaskStatus: ${_exhaustive}`);
    }
  }
}

const TasksFooter: React.FC = () => {
  const cleanup = useApprovalTaskStatus("delete_file");
  const glyphEdit = useToolTaskStatus("Edit");
  const verify = useToolTaskStatus("Bash", VERIFY_COMMAND);
  const statuses: readonly [TaskStatus, string][] = [
    [cleanup, "Clean up scratch file"],
    [glyphEdit, "Tighten glyph comment"],
    [verify, "Verify /tmp is clean"],
  ];
  const done = statuses.filter(([s]) => s === "done").length;
  const anyBlocked = statuses.some(([s]) => s === "blocked");
  return (
    <Box
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderNeutral}
      marginTop={1}
      paddingTop={0}
    >
      <Text bold color={anyBlocked ? tokens.semanticWarning : tokens.accentPrimary}>
        Tasks {done}/{statuses.length}
      </Text>
      {statuses.map(([status, label], i) => (
        <Text key={label} color={taskPillColor(status)}>
          {"  ["}
          {label}
          {"]"}
        </Text>
      ))}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Fixtures for the scripted turns.
// ---------------------------------------------------------------------------
const SCRATCH_PATH = "/tmp/deus-shell-scratch.log";
const EDIT_PATH = "src/cli/tui-v2/components/messages/ToolMessage.tsx";
const CHECK_COMMAND = `ls -la ${SCRATCH_PATH}`;
const VERIFY_COMMAND = "ls /tmp | grep deus";

if (!existsSync(SCRATCH_PATH)) {
  writeFileSync(SCRATCH_PATH, "LIA-493 full-shell scratch fixture\n");
}

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
// Streaming helper — yields growing content snapshots so text renders
// chunk-by-chunk like a real streamed turn, not a static block. Confirmed by
// reading local-thread-runtime-core.js's performRoundtrip/updateMessage:
// each yield's `content` is concatenated onto the content this step
// started with (not the previous yield's), so every yield here must
// re-supply the FULL set of parts produced so far in THIS run() call.
// ---------------------------------------------------------------------------
async function* streamTextPart(
  parts: ThreadAssistantMessagePart[],
  full: string,
  opts?: { chunkSize?: number; delayMs?: number },
): AsyncGenerator<readonly ThreadAssistantMessagePart[]> {
  const chunkSize = opts?.chunkSize ?? 3;
  const delayMs = opts?.delayMs ?? 26;
  let acc = "";
  for (let i = 0; i < full.length; i += chunkSize) {
    acc += full.slice(i, i + chunkSize);
    parts[parts.length - 1] = { type: "text", text: acc };
    yield [...parts];
    await sleep(delayMs);
  }
}

// ---------------------------------------------------------------------------
// The scripted conversation. Assistant behavior is keyed off actual thread
// STATE (which tool calls exist / are resolved), never off the literal text
// of what the human capturer types — so this runs correctly regardless of
// the exact words used for the two user turns.
//
// Suggested script for whoever drives the capture:
//   Turn 1: "Clean up that stale scratch log in /tmp, then tighten the
//            status-glyph comment in ToolMessage.tsx to use the ⏺ convention."
//   → resolve the inline permission prompt (any of the three options)
//   Turn 2: "Did that leave anything else stale in /tmp?"
// ---------------------------------------------------------------------------
let turnIndex = 0;

async function* turn1Start(): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];

  for await (const snap of streamTextPart(
    parts,
    "I'll handle both of those. Let me first check on that scratch file.",
  )) {
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

  const checkResult = existsSync(SCRATCH_PATH) ? `-rw-r--r--  1 deus  staff  36 ${SCRATCH_PATH}` : "ls: no such file";
  parts[parts.length - 1] = { ...(parts[parts.length - 1] as any), result: checkResult, isError: false };
  yield { content: [...parts] };
  await sleep(200);

  parts.push({ type: "text", text: "" });
  for await (const snap of streamTextPart(
    parts,
    "Found it — deleting it is a filesystem write, so I need your OK first.",
  )) {
    yield { content: snap };
  }
  await sleep(200);

  parts.push({
    type: "tool-call",
    toolCallId: "call-delete-scratch",
    toolName: "delete_file",
    args: { path: SCRATCH_PATH },
    argsText: JSON.stringify({ path: SCRATCH_PATH }),
    approval: { id: "appr-delete-scratch", options: PERMISSION_OPTIONS },
  } as ThreadAssistantMessagePart);
  // reason: "tool-calls" (not "interrupt") — see header comment: this is
  // what lets respondToApproval's shouldContinue check auto-resume this
  // same turn once the human decides, with no second user message needed.
  yield { content: [...parts], status: { type: "requires-action", reason: "tool-calls" } };
}

async function* turn1Continue(approved: boolean): AsyncGenerator<ChatModelRunResult> {
  const parts: ThreadAssistantMessagePart[] = [{ type: "text", text: "" }];

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
    : "All clean — nothing else stale in /tmp.";
  for await (const snap of streamTextPart(parts, closing)) {
    yield { content: snap };
  }

  yield { content: [...parts], status: { type: "complete", reason: "stop" } };
}

const adapter: ChatModelAdapter = {
  async *run(options) {
    const current = options.unstable_getMessage();
    const deleteCall = current.content.find(
      (c) => c.type === "tool-call" && c.toolName === "delete_file",
    ) as (ThreadAssistantMessagePart & { type: "tool-call" }) | undefined;
    const editCall = current.content.find((c) => c.type === "tool-call" && c.toolName === "Edit");

    if (!deleteCall) {
      turnIndex += 1;
      if (turnIndex === 1) {
        yield* turn1Start();
      } else {
        yield* turn2();
      }
      return;
    }

    if (deleteCall.approval?.approved !== undefined && !editCall) {
      yield* turn1Continue(deleteCall.approval.approved === true);
      return;
    }

    // Nothing further scripted for this state (e.g. a third message after
    // turn 2, or a re-entrant call this fixture doesn't otherwise expect).
    yield { content: [], status: { type: "complete", reason: "stop" } };
  },
};

// ---------------------------------------------------------------------------
// Message rendering — role-distinct components (spec-neutral choice, not
// mandated by cc-design-spec, but needed so a multi-turn transcript actually
// reads as a conversation): user lines get a `> ` marker in accent.info,
// assistant lines register the three tool UIs above then defer to
// MessagePrimitive.Content for text/tool-call parts.
// ---------------------------------------------------------------------------
const UserMessage: React.FC = () => (
  <Box marginBottom={1}>
    <Text color={tokens.accentInfo}>{"> "}</Text>
    <MessagePrimitive.Content />
  </Box>
);

const AssistantMessage: React.FC = () => {
  useAssistantToolUI({ toolName: "delete_file", render: PermissionToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Edit", render: EditToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Bash", render: BashToolUI, display: "standalone" });
  return (
    <Box flexDirection="column" marginBottom={1}>
      <MessagePrimitive.Content />
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Composer row — hidden in favor of a muted placeholder while a permission
// decision is pending. The library has no cross-component focus management
// (no Dialog/Modal primitive, confirmed in FINDINGS.md), so
// ComposerPrimitive.Input's own useInput stays active even while
// PermissionToolUI's chooser is open; without this, a keypress meant for the
// chooser (e.g. "1") also lands in the composer's text buffer. Not
// rendering the real input at all while awaiting approval avoids that stray
// keystroke bleed and mirrors real Claude Code, where the input area does
// not accept text while a permission prompt blocks the turn.
// ---------------------------------------------------------------------------
const ComposerRow: React.FC = () => {
  const status = useShellStatus();
  if (status === "awaiting approval") {
    return (
      <Box marginTop={1}>
        <Text color={tokens.textMuted}>&gt; </Text>
        <Text color={tokens.semanticWarning} dimColor>
          Resolve the permission prompt above to continue…
        </Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color={tokens.textMuted}>&gt; </Text>
      <ComposerPrimitive.Input submitOnEnter placeholder="Ask Deus to do something…" autoFocus />
    </Box>
  );
};

// ---------------------------------------------------------------------------
// App — the composed shell: header, transcript, in-progress spinner row,
// tasks footer, composer.
// ---------------------------------------------------------------------------
const App: React.FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" width={104}>
        <Header />
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.If running>
            <ActiveStatusRow />
          </ThreadPrimitive.If>
          <TasksFooter />
          <ComposerRow />
        </ThreadPrimitive.Root>
      </Box>
    </AssistantRuntimeProvider>
  );
};

render(<App />);
