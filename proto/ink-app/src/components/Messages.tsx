// LIA-496 — the message-list renderer, wired from App.tsx via
// `ThreadPrimitive.Messages(components={{ UserMessage, AssistantMessage }})`
// (confirm that link in App.tsx, not here). Gutter glyphs per
// design-source/taste-pass-fable.html's `.c-g` (user, amber) / `.c-g.ast`
// (assistant, dim), theme.ts's `GLYPH_USER`/`GLYPH_ASSISTANT`.
//
// AssistantMessage wires `MessagePrimitive.Parts`'s `components`:
//   - `Text: MarkdownText` — Markdown.tsx (confirm THAT link there).
//   - `Reasoning` — a small inline bordered box (not one of this stage's
//     named files; `ReasoningMessagePartComponent`/`ReasoningGroupComponent`
//     are the one surface confirmed identical on both @assistant-ui/react
//     and @assistant-ui/react-ink per LIA-495's own finding, so this is a
//     genuine two-way primitive, just not large enough to warrant its own
//     file for this spike).
//   - `tools.by_name` — `Edit: DiffPanel`, `delete_file: PermissionPrompt`
//     (both named, both confirmed wired here), `Fallback: BashLine` for
//     every other scripted tool call (`Bash`, used throughout the fixture
//     content) — not one of this stage's named files either, but needed so
//     Bash tool-calls render at all instead of vanishing silently; kept
//     small and local rather than invented as a 10th named component.
//   - `ErrorPrimitive.Root` wraps `ErrorState.tsx` once per assistant
//     message (confirm that link in ErrorState.tsx's own header comment).
import type { FC } from "react";
import { Box, Text } from "ink";
import {
  MessagePrimitive,
  ErrorPrimitive,
  useAuiState,
  type ReasoningGroupComponent,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react-ink";
import { liveBulletStatus } from "@lia496/shared";
import { theme, GLYPH_USER, GLYPH_ASSISTANT, STATUS_COLOR } from "../theme";
import { MarkdownText } from "./Markdown";
import { DiffPanel } from "./DiffPanel";
import { PermissionPrompt } from "./PermissionPrompt";
import { ErrorState } from "./ErrorState";

const BULLET = "⏺";

// Exported (LIA-496 IB1 spike, `spike/approach-a.tsx`) so the
// prop-reconstruction candidate can reuse this EXACT leaf component instead
// of hand-duplicating it — the spike write-up itself lives in
// `spike/approach-a.tsx`/`spike/approach-b.tsx`'s own header comments (no
// separate `docs/decisions/` note exists for it; this comment previously
// pointed at one that was never actually created). Not otherwise a public
// API of this module; Messages.tsx's own wiring below still uses it as a
// plain local const.
export const BashLine: FC<ToolCallMessagePartProps> = (props) => {
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = STATUS_COLOR[liveBulletStatus(pending, isError)];
  const command = (props.args as { command?: string } | undefined)?.command ?? props.argsText;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text bold>{props.toolName}</Text>
        <Text>(</Text>
        <Text color={theme.dim}>{command}</Text>
        <Text>)</Text>
      </Box>
      <Box>
        <Text color={pending ? theme.dim : theme.ink}>
          {"  "}
          {pending ? "running…" : String(props.result)}
        </Text>
      </Box>
    </Box>
  );
};

const ReasoningLine: FC<ReasoningMessagePartProps> = (props) => (
  <Text color={theme.dim} italic>
    {props.text}
  </Text>
);

const ReasoningGroup: ReasoningGroupComponent = ({ endIndex, children }) => {
  const stillStreaming = useAuiState((s) => s.message.parts[endIndex]?.status?.type === "running");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.line} paddingX={1} marginBottom={1}>
      <Text color={theme.dim}>{stillStreaming ? "thinking…" : "thought"}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
};

export const UserMessage: FC = () => (
  <Box flexDirection="row" marginBottom={1}>
    <Box width={2}>
      <Text color={theme.amber} bold>
        {GLYPH_USER}
      </Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <Text color={theme.dim}>you</Text>
      <Text>
        <MessagePrimitive.Content />
      </Text>
    </Box>
  </Box>
);

// Exported (LIA-496 IB1 REVISE round — part-granularity commits, code-review
// finding) so `committedBlocks.tsx`'s per-part committed renderer AND this
// file's own live `AssistantMessage` dispatch off the exact SAME
// `MessagePrimitive.Parts`/`MessagePrimitive.PartByIndex` `components`
// config — never duplicated between the two call sites (this repo's own
// "never duplicate content across files" rule). See `committedBlocks.tsx`'s
// header comment for why part-level (not message-level) dispatch is now
// required at all.
export const assistantPartComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningLine,
  ReasoningGroup,
  tools: {
    by_name: {
      Edit: DiffPanel,
      delete_file: PermissionPrompt,
    },
    Fallback: BashLine,
  },
};

export const AssistantMessage: FC = () => (
  <Box flexDirection="row" marginBottom={1}>
    <Box width={2}>
      <Text color={theme.dim} bold>
        {GLYPH_ASSISTANT}
      </Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <Text color={theme.dim}>deus</Text>
      <ErrorPrimitive.Root>
        <ErrorState />
      </ErrorPrimitive.Root>
      <MessagePrimitive.Parts components={assistantPartComponents} unstable_showEmptyOnNonTextEnd={false} />
    </Box>
  </Box>
);
