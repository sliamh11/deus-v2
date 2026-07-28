// LIA-495 — ported from full-shell.tsx's UserMessage/AssistantMessage.
// `MessagePrimitive.Parts` (not `.Content`) is the primitive that groups
// consecutive reasoning parts into a single `ReasoningGroupComponent`
// (confirmed identical shape on web — see MessageParts.d.ts under
// @assistant-ui/core: `components.Reasoning`/`components.ReasoningGroup`/
// `unstable_showEmptyOnNonTextEnd` all present, unchanged from the ink
// version). Bash/Edit/delete_file keep rendering exactly as ported: the
// tool-call branch resolves the same `useAssistantToolUI` registry either
// target uses.
import type { FC } from "react";
import { MessagePrimitive, useAssistantToolUI } from "@assistant-ui/react";
import { tokens } from "../runtime/tokens";
import { PermissionToolUI } from "./PermissionToolUI";
import { EditToolUI } from "./EditToolUI";
import { BashToolUI } from "./BashToolUI";
import { ReasoningPartUI, ReasoningGroupUI } from "./Reasoning";

// RECONCILE fix (code-review finding, Medium — see migrated-ink-demo's
// matching comment): `useAssistantToolUI` is deprecated and toolName-keyed;
// calling it from AssistantMessage re-registered all 3 tool renderers on
// every newly-mounted message. Idempotent (never a correctness bug), but
// redundant per-message work for a thread-wide concern. Moved to a
// once-per-thread registration component mounted by App.
export const ToolUIRegistrations: FC = () => {
  useAssistantToolUI({ toolName: "delete_file", render: PermissionToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Edit", render: EditToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Bash", render: BashToolUI, display: "standalone" });
  return null;
};

export const UserMessage: FC = () => (
  <div style={{ marginBottom: 16, display: "flex", gap: 6 }}>
    <span style={{ color: tokens.accentInfo }}>{"> "}</span>
    <MessagePrimitive.Content />
  </div>
);

export const AssistantMessage: FC = () => {
  return (
    <div style={{ marginBottom: 16 }}>
      <MessagePrimitive.Parts
        components={{ Reasoning: ReasoningPartUI, ReasoningGroup: ReasoningGroupUI }}
        unstable_showEmptyOnNonTextEnd={false}
      />
    </div>
  );
};
