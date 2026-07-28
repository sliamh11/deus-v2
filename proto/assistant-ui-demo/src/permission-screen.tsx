// LIA-493 prototype — screen 1 of 2: the three-way permission-prompt flow.
//
// Goal: replicate deus-v2-mvp's real PermissionModal.tsx decision semantics
// (allow-once / allow-always / deny — NOT a plain yes/no) on top of
// @assistant-ui/react-ink, and see how much of the "chooser" is free vs DIY.
//
// Reused verbatim from setup-stage research:
//   - Deus's PermissionDecision union ('allow_once'|'allow_always'|'deny')
//     from deus-v2-mvp/src/agent-runtimes/types.ts:122
//   - Deus's PERMISSION_LIST_OPTIONS row shape/order/labels from
//     deus-v2-mvp/src/cli/tui-v2/deus-tui-permission-decision-v2.ts
//   - The library's real, typed approval data model from
//     @assistant-ui/core: ToolCallMessagePart.approval / ToolApprovalOption /
//     ToolCallMessagePartProps.respondToApproval (see message.d.ts,
//     MessagePartComponentTypes.d.ts) — there is NO pre-built interactive
//     chooser component anywhere in dist/primitives (confirmed by directory
//     listing), so the cursor loop below is 100% hand-rolled, same shape as
//     the real PermissionModal.tsx (cursorIndex + options[] + useInput).
//
// Round-3 redesign (LIA-493 comparison round, per cc-design-spec's Per-
// Candidate Application Plan): re-skinned around the shared Claude Code
// design-language tokens/glyph conventions below. The library-owned data
// model (approval / ToolApprovalOption[] / respondToApproval / the
// message-level requires-action status) and the hand-rolled useInput cursor
// loop are UNCHANGED — only presentation moved. See the "Round-3 visual
// redesign" comments inline for what changed and why.
//
// Round-3 RECONCILE fixes (GPT-5.6-Sol review, REVISE verdict — see
// FINDINGS.md "Round 3" for the full record):
//   - [SUCCESS-STYLING-REGRESSION, finding #1] The approval decision alone
//     used to color the collapsed row semantic.success even though the
//     scripted adapter never actually executed delete_file. Fixed by making
//     this screen perform a REAL fs deletion of a real scratch file the
//     moment the human (or an auto-grant) approves, and coloring the row
//     from the actual observed outcome (`executionOutcomes`), never from the
//     decision alone. semantic.warning is used for the brief in-between
//     state where a decision is recorded but execution hasn't resolved yet.
//   - [CONFIRMED-SPEC-VIOLATION, finding #7] The resolved/collapsed row used
//     to reconstruct the path as plain interpolated text, losing the OSC 8
//     hyperlink. Fixed: the resolved row renders the same <ToolPath/>
//     component as the unresolved panel.
//   - [CONFIRMED-SPEC-VIOLATION, finding #6] "Always allow" used to end
//     after the first approval with no persisted-grant demonstration. Fixed:
//     a second user turn now gets a SECOND delete_file request that is
//     resolved automatically (approval.isAutomatic — the library's own field
//     for exactly this case, confirmed in @assistant-ui/core's
//     message.d.ts) with no interactive prompt, and the resolved row labels
//     it "(auto-approved — grant persists from earlier decision)".
//
// NOTE on the naming collision flagged in the task brief: the "ChatTransport"
// in Deus's own deus-native-chat-client.ts:125 is unrelated to anything here.
// This file only ever talks about assistant-ui's ChatModelAdapter.

import { render, Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAssistantToolUI,
  type ChatModelAdapter,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react-ink";
import type { ToolApprovalOption, ToolApprovalResponse } from "@assistant-ui/core";

// ---------------------------------------------------------------------------
// Shared Claude Code design-language tokens (cc-design-spec.md § Color
// system). Named tokens with explicit hex values, passed straight to Ink's
// `color`/`borderColor` props — never bare color names like "yellow"/"cyan".
// `textPrimary` targets the default-dark-canvas pairing (surface.dark +
// surface.light-as-foreground) the spec describes first; there is no
// terminal-theme detection in this prototype, so this is a fixed choice,
// not an adaptive one.
// ---------------------------------------------------------------------------
const tokens = {
  textMuted: "#B0AEA5",
  textPrimary: "#FAF9F5",
  accentPrimary: "#D97757",
  accentInfo: "#6A9BCC",
  semanticSuccess: "#788C5D",
  semanticWarning: "#C49A52",
  semanticError: "#B95C50",
} as const;

// The single stateful glyph. Per spec: "do not switch between unrelated
// success/error glyph families such as ✓, ✗, and ? in the tool-call header."
const BULLET = "⏺";

// ---------------------------------------------------------------------------
// OSC 8 path hyperlink helper (cc-design-spec.md § Tool-call typography and
// glyphs → "For file paths"). No terminal-link package is installed and this
// prototype must not run `npm install`, so this is a minimal hand-rolled
// implementation of the same escape-sequence contract: `ESC ]8;;URI BEL
// label ESC ]8;; BEL`. Verified this doesn't corrupt Ink's layout math: Ink's
// string-width dependency strips ANSI/OSC sequences terminated by BEL
// () or ST before measuring visible width (confirmed by reading
// node_modules/ansi-regex/index.js's `osc` pattern), so the escape codes
// don't get counted as visible columns inside the bordered panel.
// ---------------------------------------------------------------------------
const OSC8_ESC = "";
const OSC8_BEL = "";

function oscHyperlink(url: string, label: string): string {
  return `${OSC8_ESC}]8;;${url}${OSC8_BEL}${label}${OSC8_ESC}]8;;${OSC8_BEL}`;
}

// Resolve relative paths against the client's working directory; render the
// original (already-concise) path as the visible label rather than the
// resolved absolute form, per "Render the concise project-relative path as
// the visible label."
function pathHyperlink(rawPath: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolvePath(process.cwd(), rawPath);
  return oscHyperlink(`file://${encodeURI(abs)}`, rawPath);
}

const ToolPath: React.FC<{ path: string }> = ({ path }) => (
  <Text color={tokens.accentInfo}>{pathHyperlink(path)}</Text>
);

// Extract a file path from structured tool args (`{ path: "..." }`) instead
// of ever displaying raw JSON as the primary presentation, per the redesign
// brief. Falls back to `undefined` for tools whose args don't carry a path.
function extractPath(args: unknown): string | undefined {
  if (args && typeof args === "object" && "path" in (args as Record<string, unknown>)) {
    const p = (args as { path?: unknown }).path;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deus's real 3-way decision model (PermissionDecision, deus-tui-permission-
// decision-v2.ts). We map it onto the library's ToolApprovalOption shape:
// the library splits "deny" into reject-once/reject-always; Deus only has
// one deny, so we use "reject-once" for it (per the setup-stage's own
// suggested mapping) and carry Deus's decision id in each option's `id`.
// UNCHANGED by the round-3 redesign — this is the library-owned data model
// contract the redesign is required to preserve verbatim.
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

// ---------------------------------------------------------------------------
// RECONCILE fix for finding #1 (SUCCESS-STYLING-REGRESSION): approving a
// tool call is a DECISION, not a completed operation. The scripted demo
// makes that distinction real instead of asserted: on approval we actually
// delete a real scratch file and only color the row from the observed
// outcome. `executionOutcomes` is keyed by the approval's own `id` (stable
// per tool-call) so both the interactive path (confirm()) and the
// auto-approved persisted-grant path (the adapter, for finding #6) can
// record a real result and ResolvedRow can read it back regardless of which
// path produced it.
// ---------------------------------------------------------------------------
const executionOutcomes = new Map<string, "success" | "error">();

function performDelete(targetPath: string, approvalId: string): "success" | "error" {
  try {
    rmSync(targetPath, { force: false });
    const outcome: "success" | "error" = existsSync(targetPath) ? "error" : "success";
    executionOutcomes.set(approvalId, outcome);
    return outcome;
  } catch {
    executionOutcomes.set(approvalId, "error");
    return "error";
  }
}

// Deny never attempts an execution — there is nothing to observe, so it
// stays semantic.error (the review did not flag this branch; only the
// false-positive success case was a regression).
function decisionColor(
  decision: PermissionDecision,
  execOutcome: "success" | "error" | undefined,
): string {
  switch (decision) {
    case "allow_once":
    case "allow_always":
      if (execOutcome === "success") return tokens.semanticSuccess;
      if (execOutcome === "error") return tokens.semanticError;
      // Approved but no observed execution outcome yet — never claim
      // success from the decision alone.
      return tokens.semanticWarning;
    case "deny":
      return tokens.semanticError;
  }
}

// ---------------------------------------------------------------------------
// Numbered option row — replaces the prior `●` marker + generic cyan/yellow
// named colors with the shared tokens: `›` for the selected row in
// accent.primary, accent.info for the "Always allow" persistent-scope note.
// ---------------------------------------------------------------------------
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
      {option.kind === "allow-always" && (
        <Text color={tokens.accentInfo}> (persists until revoked)</Text>
      )}
    </Text>
  );
};

// ---------------------------------------------------------------------------
// The hand-rolled chooser. Mirrors PermissionModal.tsx's shape: cursorIndex +
// a fixed options list + useInput forwarding up/down/return, now also
// accepting direct 1/2/3 selection per the redesign brief. Unlike the real
// component (whose cursorIndex lives in global TuiState, and whose decision
// resolution lives in a separate `tuiReduce`/`permissionListKeyToResult`
// reducer), this prototype keeps both in the component for brevity — a real
// port would keep that separation. No auto-deny countdown here (the
// @assistant-ui/react-ink section of the redesign brief does not list one
// for this candidate's permission screen, unlike the @ai-sdk/tui screen) —
// carried forward as out of scope from round 2.
// ---------------------------------------------------------------------------
const PermissionToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  const [cursorIndex, setCursorIndex] = useState(0);
  const approval = props.approval;
  const options = (approval?.options as readonly ToolApprovalOption[] | undefined) ?? PERMISSION_OPTIONS;

  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);
  const path = extractPath(props.args);

  const confirm = (index: number) => {
    const chosen = options[index];
    const approved = chosen.kind === "allow-once" || chosen.kind === "allow-always";
    // Perform the real operation NOW, synchronously, before responding —
    // so the resolved row below reflects an actually-observed outcome
    // rather than the decision alone (finding #1 fix).
    if (approved && approval?.id && path) {
      performDelete(path, approval.id);
    }
    const response: ToolApprovalResponse = {
      approved,
      optionId: chosen.id,
    };
    props.respondToApproval(response);
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
      if (key.upArrow) {
        setCursorIndex((i) => (i - 1 + options.length) % options.length);
      } else if (key.downArrow) {
        setCursorIndex((i) => (i + 1) % options.length);
      } else if (key.return) {
        confirm(cursorIndex);
      }
    },
    { isActive: !resolved },
  );

  // Post-resolution: collapse the panel into a concise tool-call row (spec's
  // Permission prompt implementation rules) instead of keeping the bordered
  // chooser on screen.
  if (resolved && approval) {
    return (
      <Box marginY={1}>
        <ResolvedRow approval={approval} options={options} toolName={props.toolName} path={path} argsText={props.argsText} />
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

// ResolvedRow — the stateful ⏺ convention: semantic.success only once a real
// execution outcome is observed for an approved decision, semantic.error for
// denial OR a failed execution. Cancellation/expiry stays semantic.warning
// and is never mistaken for success. RECONCILE fix for finding #7: the path
// is rendered through the same <ToolPath/> OSC 8 component as the unresolved
// panel, instead of being flattened into plain interpolated text — a
// resolved tool-call keeps its clickable path.
const ResolvedRow: React.FC<{
  approval: NonNullable<ToolCallMessagePartProps["approval"]>;
  options: readonly ToolApprovalOption[];
  toolName: string;
  path: string | undefined;
  argsText: string;
}> = ({ approval, options, toolName, path, argsText }) => {
  if (approval.resolution) {
    // Terminal non-decision state (cancelled/expired) — never render this as
    // a false-positive success glyph.
    return (
      <Text color={tokens.semanticWarning}>
        {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — request {approval.resolution}, no decision
        made
      </Text>
    );
  }

  const decision = decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
  const label = options.find((o) => o.id === approval.optionId)?.label ?? decision;
  const execOutcome = approval.id ? executionOutcomes.get(approval.id) : undefined;
  const outcomeText =
    decision === "deny"
      ? undefined
      : execOutcome === "success"
        ? "deleted"
        : execOutcome === "error"
          ? "delete failed"
          : "awaiting execution";

  return (
    <Text color={decisionColor(decision, execOutcome)}>
      {BULLET} {toolName}({path ? <ToolPath path={path} /> : argsText}) — {label}
      {outcomeText ? ` (${outcomeText})` : ""}
      {approval.isAutomatic ? " — auto-approved: grant persists from earlier decision" : ""}
    </Text>
  );
};

// ---------------------------------------------------------------------------
// Adapter: a scripted scenario so the recording is deterministic.
//
// Turn 1 (any user message) → assistant asks to delete a scratch file and
// requests interactive approval. If that decision was "Always allow", a
// SECOND user turn demonstrates the persisted grant (finding #6 fix): the
// assistant requests deleting a second scratch file and the tool-call
// arrives ALREADY resolved (`approval.isAutomatic: true`, no interactive
// prompt) — the library's own field for exactly this case (confirmed by
// reading @assistant-ui/core's message.d.ts: `approval.isAutomatic`).
//
// Because respondToApproval updates props.approval on the existing message
// part directly (client-side store field, not new model content), the
// resolved view above re-renders from that alone — we don't depend on
// whether the runtime re-invokes run() after the decision. The guards below
// make repeated adapter.run() invocations safe instead of appending
// duplicate content forever.
// ---------------------------------------------------------------------------
let toolCallSeq = 0;
let alwaysAllowGranted = false;
let autoGrantDemoDone = false;

const SCRATCH_FILE_1 = "/tmp/deus-scratch.log";
const SCRATCH_FILE_2 = "/tmp/deus-scratch-2.log";

// Ensure both scratch files exist before the demo starts so an approved
// delete_file call has a REAL file to delete (and a real, observable
// outcome) rather than trivially "succeeding" against nothing.
for (const f of [SCRATCH_FILE_1, SCRATCH_FILE_2]) {
  if (!existsSync(f)) writeFileSync(f, "LIA-493 permission-screen scratch fixture\n");
}

const adapter: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages[messages.length - 1];
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const priorToolCall = lastAssistant?.content.find((p) => p.type === "tool-call") as
      | { approval?: { approved?: boolean; optionId?: string } }
      | undefined;

    if (priorToolCall?.approval?.optionId === "allow_always") {
      alwaysAllowGranted = true;
    }

    if (last?.role === "user" && !priorToolCall) {
      toolCallSeq += 1;
      yield {
        // respondToToolApproval (local-thread-runtime-core.ts:679) throws
        // unless the MESSAGE's own status is exactly {type:"requires-action"}
        // — a message-level flag, not derivable from the tool-call part's own
        // fields. Confirmed the hard way: first version omitted this and the
        // real library threw "message whose status is not requires-action"
        // the instant the interactive chooser tried to confirm a decision.
        status: { type: "requires-action", reason: "interrupt" },
        content: [
          { type: "text", text: "I'd like to clean up a scratch file before we continue." },
          {
            type: "tool-call",
            toolCallId: `call-${toolCallSeq}`,
            toolName: "delete_file",
            args: { path: SCRATCH_FILE_1 },
            argsText: JSON.stringify({ path: SCRATCH_FILE_1 }),
            approval: {
              id: `appr-${toolCallSeq}`,
              options: PERMISSION_OPTIONS,
            },
          },
        ],
      };
      return;
    }

    // Second real user turn after an "Always allow" grant: demonstrate the
    // persisted grant with a genuinely NEW tool-call that never goes through
    // the interactive chooser (finding #6 fix).
    if (last?.role === "user" && priorToolCall && alwaysAllowGranted && !autoGrantDemoDone) {
      autoGrantDemoDone = true;
      toolCallSeq += 1;
      const approvalId = `appr-${toolCallSeq}`;
      // Perform the deletion for real, same as the interactive path, before
      // presenting the already-resolved tool-call.
      performDelete(SCRATCH_FILE_2, approvalId);
      yield {
        status: { type: "complete", reason: "stop" },
        content: [
          {
            type: "text",
            text: "Cleaning up another scratch file too — already covered by your earlier \"Always allow\".",
          },
          {
            type: "tool-call",
            toolCallId: `call-${toolCallSeq}`,
            toolName: "delete_file",
            args: { path: SCRATCH_FILE_2 },
            argsText: JSON.stringify({ path: SCRATCH_FILE_2 }),
            approval: {
              id: approvalId,
              options: PERMISSION_OPTIONS,
              optionId: "allow_always",
              approved: true,
              isAutomatic: true,
            },
          },
        ],
      };
      return;
    }

    // Decision already resolved and nothing further for this scripted demo
    // to add. Returning empty content avoids a duplicate/looping follow-up
    // message regardless of whether the runtime calls run() again.
    yield { content: [] };
  },
};

// ---------------------------------------------------------------------------
// Message rendering: register the custom tool UI (per the setup stage's own
// conclusion — useAssistantToolUI is the load-bearing seam here, despite its
// @deprecated tag pointing at toolkit-level render/renderText for new code)
// then let MessagePrimitive.Content dispatch text vs tool-call parts.
// ---------------------------------------------------------------------------
const Message: React.FC = () => {
  useAssistantToolUI({ toolName: "delete_file", render: PermissionToolUI, display: "standalone" });
  return (
    <Box flexDirection="column">
      <MessagePrimitive.Content />
    </Box>
  );
};

// Round-3 redesign: dropped the visible "LIA-493 prototype" heading and
// underlined demo copy so the capture reads as a real chat surface, per the
// redesign brief. AssistantRuntimeProvider / useLocalRuntime / ThreadPrimitive
// / ComposerPrimitive stay intact — this screen keeps testing the real
// approval runtime rather than degrading into a plain Ink fixture.
const App: React.FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" width={100}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ Message }} />
          <Box marginTop={1}>
            <Text color={tokens.textMuted}>&gt; </Text>
            <ComposerPrimitive.Input submitOnEnter placeholder="Ask Deus to do something…" autoFocus />
          </Box>
        </ThreadPrimitive.Root>
      </Box>
    </AssistantRuntimeProvider>
  );
};

render(<App />);
