// LIA-496 — Thread.tsx <- App.tsx, inside AssistantRuntimeProvider.
// ThreadPrimitive.Root/Messages(components={{UserMessage,
// AssistantMessage}})/Empty, per the S1 dispatch. AssistantMessage wires
// MessagePrimitive.Parts' `components.Text` -> MarkdownText.tsx (which
// itself wires `components.code` -> CodeBlock.tsx — see that file's header
// comment for why this two-hop link matters) and `components.tools.by_name`
// -> DiffPanel.tsx (Edit) / PermissionCard.tsx (delete_file), plus the
// per-message footer (ActionBar.tsx + BranchPicker.tsx) and ErrorState.tsx.
import type { FC } from "react";
import {
  ThreadPrimitive,
  MessagePrimitive,
  useAuiState,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownText } from "./MarkdownText";
import { DiffPanel } from "./DiffPanel";
import { PermissionCard } from "./PermissionCard";
import { ActionBar } from "./ActionBar";
import { BranchPicker } from "./BranchPicker";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";

const ReasoningPart: FC<ReasoningMessagePartProps> = ({ text }) =>
  text ? <p className="s-reasoning">{text}</p> : null;

// Fallback for tool calls that aren't Edit/delete_file (Bash, the various
// `grep`/`ls` checks the fixture scripts run) — a compact inline line
// rather than a silent gap, matching the design source's understated
// treatment of intermediate tool activity.
const GenericToolLine: FC<ToolCallMessagePartProps> = (props) => (
  <div className="s-toolline">
    <span>{props.toolName}</span>
    <span className="dot">·</span>
    <span>{typeof props.result === "string" ? props.result : props.argsText}</span>
  </div>
);

const messageComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningPart,
  tools: {
    by_name: { Edit: DiffPanel, delete_file: PermissionCard },
    Fallback: GenericToolLine,
  },
};

const UserMessage: FC = () => (
  <div className="s-user">
    <div className="chip">
      <MessagePrimitive.Content />
    </div>
  </div>
);

const AssistantMessage: FC = () => (
  <div className="s-msg-group">
    <MessagePrimitive.Parts components={messageComponents} unstable_showEmptyOnNonTextEnd={false} />
    <ErrorState />
    <div className="s-footer">
      <ActionBar />
      <BranchPicker />
    </div>
  </div>
);

export const Thread: FC<{ onOpenDrawer: () => void }> = ({ onOpenDrawer }) => {
  const title = useAuiState((s) => s.threadListItem.title);

  return (
    <ThreadPrimitive.Root style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="s-top">
        <div className="s-top-left">
          <button className="s-drawer-open" onClick={onOpenDrawer} aria-label="Open sidebar">
            ☰
          </button>
          <h2 className="serif">{title ?? "New chat"}</h2>
        </div>
        <span className="s-model">Sonnet 5</span>
      </div>
      <ThreadPrimitive.Viewport className="s-thread">
        <div className="s-col">
          <ThreadPrimitive.Empty>
            <EmptyState />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};
