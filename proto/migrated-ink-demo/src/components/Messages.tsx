// LIA-495 — Ink equivalent of web-first-demo's Messages
// (UserMessage/AssistantMessage), itself ported from full-shell.tsx.
// `MessagePrimitive.Parts` (not `.Content`) is the primitive that groups
// consecutive reasoning parts into a single `ReasoningGroupComponent`,
// confirmed identical shape on Ink (same `components.Reasoning`/
// `components.ReasoningGroup`/`unstable_showEmptyOnNonTextEnd` surface
// full-shell.tsx used and web-first-demo confirmed also exists on web).
// Bash/Edit/delete_file keep rendering exactly as ported: the tool-call
// branch resolves the same `useAssistantToolUI` registry either target
// uses.
import type { FC } from "react";
import { Box, Text } from "ink";
import { MessagePrimitive, useAssistantToolUI } from "@assistant-ui/react-ink";
import { tokens } from "../runtime/tokens";
import { PermissionToolUI } from "./PermissionToolUI";
import { EditToolUI } from "./EditToolUI";
import { BashToolUI } from "./BashToolUI";
import { ReasoningPartUI, ReasoningGroupUI } from "./Reasoning";

// RECONCILE fix (code-review finding, Medium): `useAssistantToolUI` is a
// deprecated toolName-keyed registration effect (see its own @deprecated
// docstring in @assistant-ui/core) — calling it from AssistantMessage meant
// every newly-mounted assistant message re-registered all 3 tool renderers.
// Registration is idempotent (setToolUI keys by toolName, so this was never
// a correctness bug), but it's still redundant per-message work for a
// thread-wide concern. Moved to `ToolUIRegistrations`, mounted once by App.
export const ToolUIRegistrations: FC = () => {
  useAssistantToolUI({ toolName: "delete_file", render: PermissionToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Edit", render: EditToolUI, display: "standalone" });
  useAssistantToolUI({ toolName: "Bash", render: BashToolUI, display: "standalone" });
  return null;
};

export const UserMessage: FC = () => (
  <Box marginBottom={1}>
    <Text color={tokens.accentInfo}>{"> "}</Text>
    <MessagePrimitive.Content />
  </Box>
);

export const AssistantMessage: FC = () => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <MessagePrimitive.Parts
        components={{ Reasoning: ReasoningPartUI, ReasoningGroup: ReasoningGroupUI }}
        unstable_showEmptyOnNonTextEnd={false}
      />
    </Box>
  );
};
