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
// NOTE on the naming collision flagged in the task brief: the "ChatTransport"
// in Deus's own deus-native-chat-client.ts:125 is unrelated to anything here.
// This file only ever talks about assistant-ui's ChatModelAdapter.

import { render, Box, Text, useInput } from "ink";
import React, { useState } from "react";
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
// Deus's real 3-way decision model (PermissionDecision, deus-tui-permission-
// decision-v2.ts). We map it onto the library's ToolApprovalOption shape:
// the library splits "deny" into reject-once/reject-always; Deus only has
// one deny, so we use "reject-once" for it (per the setup-stage's own
// suggested mapping) and carry Deus's decision id in each option's `id`.
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

// statusGlyph — same contract as the real ToolMessage.tsx's statusGlyph():
// never show green on anything but a genuine allow.
function decisionGlyph(decision: PermissionDecision): { glyph: string; color: string } {
  switch (decision) {
    case "allow_once":
      return { glyph: "✓ ", color: "green" };
    case "allow_always":
      return { glyph: "✓ ", color: "green" };
    case "deny":
      return { glyph: "✗ ", color: "red" };
  }
}

// ---------------------------------------------------------------------------
// The hand-rolled chooser. Mirrors PermissionModal.tsx's shape: cursorIndex +
// a fixed options list + useInput forwarding up/down/return. Unlike the real
// component (whose cursorIndex lives in global TuiState, and whose decision
// resolution lives in a separate `tuiReduce`/`permissionListKeyToResult`
// reducer), this prototype keeps both in the component for brevity — a real
// port would keep that separation. No auto-deny countdown here either
// (DENY_TIMEOUT_MS in the real component) — out of scope for this screen.
// ---------------------------------------------------------------------------
const PermissionToolUI: React.FC<ToolCallMessagePartProps> = (props) => {
  const [cursorIndex, setCursorIndex] = useState(0);
  const approval = props.approval;
  const options = (approval?.options as readonly ToolApprovalOption[] | undefined) ?? PERMISSION_OPTIONS;

  const resolved = approval !== undefined && (approval.approved !== undefined || approval.resolution !== undefined);

  useInput(
    (_input, key) => {
      if (resolved) return;
      if (key.upArrow) {
        setCursorIndex((i) => (i - 1 + options.length) % options.length);
      } else if (key.downArrow) {
        setCursorIndex((i) => (i + 1) % options.length);
      } else if (key.return) {
        const chosen = options[cursorIndex];
        const response: ToolApprovalResponse = {
          approved: chosen.kind === "allow-once" || chosen.kind === "allow-always",
          optionId: chosen.id,
        };
        props.respondToApproval(response);
      }
    },
    { isActive: !resolved },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold>
        Tool wants to run: <Text color="cyan">{props.toolName}</Text>
      </Text>
      <Text dimColor>{props.argsText}</Text>
      <Box marginTop={1} flexDirection="column">
        {resolved ? (
          <ResolvedRow approval={approval} options={options} />
        ) : (
          options.map((opt, i) => {
            const selected = i === cursorIndex;
            const isAlwaysAllow = opt.kind === "allow-always";
            return (
              <Text key={opt.id} color={isAlwaysAllow ? "cyan" : selected ? "yellow" : undefined}>
                {selected ? "● " : "  "}
                {opt.label ?? opt.id}
              </Text>
            );
          })
        )}
      </Box>
      {!resolved && (
        <Box marginTop={1}>
          <Text dimColor>↑/↓ to choose · enter to confirm</Text>
        </Box>
      )}
    </Box>
  );
};

const ResolvedRow: React.FC<{
  approval: NonNullable<ToolCallMessagePartProps["approval"]>;
  options: readonly ToolApprovalOption[];
}> = ({ approval, options }) => {
  if (approval.resolution) {
    // Terminal non-decision state (cancelled/expired) — never render this as
    // a false-positive success glyph.
    return <Text color="yellow">? Request {approval.resolution}, no decision made</Text>;
  }
  const decision = decisionFromOptionId(approval.optionId) ?? (approval.approved ? "allow_once" : "deny");
  const label = options.find((o) => o.id === approval.optionId)?.label ?? decision;
  const { glyph, color } = decisionGlyph(decision);
  return (
    <Text color={color}>
      {glyph}Decision: {label}
    </Text>
  );
};

// ---------------------------------------------------------------------------
// Adapter: a single scripted scenario so the recording is deterministic.
// Turn 1 (any user message) → assistant asks to delete a scratch file and
// requests approval. Because respondToApproval updates props.approval on the
// existing message part directly (client-side store field, not new model
// content), the resolved view above re-renders from that alone — we don't
// depend on whether the runtime re-invokes run() after the decision. The
// length guard below just makes a second invocation (if the runtime does
// re-call adapter.run() to let the "model" react to the decision) safe
// instead of appending duplicate content forever.
// ---------------------------------------------------------------------------
let toolCallSeq = 0;

const adapter: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages[messages.length - 1];
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const priorToolCall = lastAssistant?.content.find((p) => p.type === "tool-call") as
      | { approval?: { approved?: boolean; optionId?: string } }
      | undefined;

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
            args: { path: "/tmp/deus-scratch.log" },
            argsText: JSON.stringify({ path: "/tmp/deus-scratch.log" }),
            approval: {
              id: `appr-${toolCallSeq}`,
              options: PERMISSION_OPTIONS,
            },
          },
        ],
      };
      return;
    }

    // Decision already resolved on the existing tool-call part — nothing
    // further for this scripted demo to add. Returning empty content avoids
    // a duplicate/looping follow-up message regardless of whether the
    // runtime calls run() again post-approval.
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

const App: React.FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Box flexDirection="column" width={100}>
        <Text bold underline>
          LIA-493 prototype — permission-prompt screen (allow-once / allow-always / deny)
        </Text>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ Message }} />
          <Box marginTop={1}>
            <Text dimColor>&gt; </Text>
            <ComposerPrimitive.Input submitOnEnter placeholder="Ask Deus to do something…" autoFocus />
          </Box>
        </ThreadPrimitive.Root>
      </Box>
    </AssistantRuntimeProvider>
  );
};

render(<App />);
