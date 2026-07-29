// LIA-496 IB1 spike — Approach A: prop reconstruction.
// SPIKE-ONLY scratch entry point. Not wired into App.tsx.
//
// Reads the plain completed-message snapshot (SPIKE_ASSISTANT_MESSAGE from
// fixture.ts — no AssistantRuntimeProvider, no useLocalRuntime, no
// @assistant-ui context at all) and reuses the EXISTING leaf components
// (MarkdownText, BashLine, PermissionPrompt) by constructing their props
// explicitly from that snapshot. The chrome (gutter glyph, "deus" label,
// column layout) is hand-reconstructed too, since there is no
// runtime-context-free way to reuse AssistantMessage/UserMessage
// themselves (they take zero props and read everything from
// useAuiState/MessagePrimitive context).
import type { FC } from "react";
import { render, Box, Text, Static } from "ink";
import type { ToolCallMessagePartProps, TextMessagePartProps } from "@assistant-ui/react-ink";
import { theme, GLYPH_ASSISTANT, GLYPH_USER } from "../theme";
import { MarkdownText } from "../components/Markdown";
import { BashLine } from "../components/Messages";
import { PermissionPrompt } from "../components/PermissionPrompt";
import { SPIKE_ASSISTANT_MESSAGE, SPIKE_USER_MESSAGE } from "./fixture";

function noop(label: string) {
  return (...args: unknown[]) => {
    // A committed/historical snapshot should NEVER trigger these — if one
    // fires, that is itself a spike finding, so it's logged loudly rather
    // than silently swallowed.
    // eslint-disable-next-line no-console
    console.error(`[approach-a SPIKE FAIL] ${label} called on a committed snapshot`, args);
  };
}

// Constructs a full ToolCallMessagePartProps from the raw fixture content
// part — the "hand-typed snapshot type" the plan's Approach B description
// warns is the cost of this approach.
function toToolCallProps(part: Extract<(typeof SPIKE_ASSISTANT_MESSAGE.content)[number], { type: "tool-call" }>): ToolCallMessagePartProps {
  return {
    type: "tool-call",
    toolCallId: part.toolCallId!,
    toolName: part.toolName,
    args: part.args ?? {},
    argsText: part.argsText ?? "",
    result: part.result,
    isError: part.isError,
    approval: part.approval,
    status: { type: "complete" },
    addResult: noop("addResult"),
    resume: noop("resume"),
    respondToApproval: noop("respondToApproval"),
  } as ToolCallMessagePartProps;
}

function toTextProps(text: string): TextMessagePartProps {
  return { type: "text", text, status: { type: "complete" } } as TextMessagePartProps;
}

const CommittedUserMessage: FC = () => (
  <Box flexDirection="row" marginBottom={1}>
    <Box width={2}>
      <Text color={theme.amber} bold>
        {GLYPH_USER}
      </Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <Text color={theme.dim}>you</Text>
      <Text>{String(SPIKE_USER_MESSAGE.content)}</Text>
    </Box>
  </Box>
);

const CommittedAssistantMessage: FC = () => {
  const parts = SPIKE_ASSISTANT_MESSAGE.content;
  if (typeof parts === "string") return null;

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box width={2}>
        <Text color={theme.dim} bold>
          {GLYPH_ASSISTANT}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.dim}>deus</Text>
        {parts.map((part, i) => {
          if (part.type === "text") {
            return <MarkdownText key={i} {...toTextProps(part.text)} />;
          }
          if (part.type === "tool-call") {
            const props = toToolCallProps(part as Extract<typeof part, { type: "tool-call" }>);
            if (part.toolName === "delete_file") {
              return <PermissionPrompt key={i} {...props} />;
            }
            return <BashLine key={i} {...props} />;
          }
          return null;
        })}
      </Box>
    </Box>
  );
};

const items: string[] = ["spike-user-0", "spike-assistant-0"];

const SpikeApp: FC = () => (
  <Box flexDirection="column" width={104}>
    <Text color={theme.amber} bold>
      === Approach A (prop reconstruction) — rendered inside &lt;Static&gt; ===
    </Text>
    <Static items={items}>
      {(item: string) => (item === "spike-user-0" ? <CommittedUserMessage key={item} /> : <CommittedAssistantMessage key={item} />)}
    </Static>
    <Text color={theme.ok}>=== end of Static output — dynamic tail below ===</Text>
  </Box>
);

render(<SpikeApp />);
