// LIA-496 — the message-list renderer, wired from App.tsx via
// `ThreadPrimitive.Messages(components={{ UserMessage, AssistantMessage }})`
// (confirm that link in App.tsx, not here). Gutter glyphs per
// design-source/taste-pass-fable.html's `.c-g` (user, amber) / `.c-g.ast`
// (assistant, dim), theme.ts's `GLYPH_USER`/`GLYPH_ASSISTANT`.
//
// AssistantMessage wires `MessagePrimitive.Parts`'s `components`:
//   - `Text: MarkdownText` — Markdown.tsx (confirm THAT link there).
//   - `Reasoning` — a small inline unboxed group, no border (I9, LIA-496
//     IB2 — borders reserved for composer/permission/overlays; not one of
//     this stage's named files; `ReasoningMessagePartComponent`/
//     `ReasoningGroupComponent` are the one surface confirmed identical on
//     both @assistant-ui/react and @assistant-ui/react-ink per LIA-495's
//     own finding, so this is a genuine two-way primitive, just not large
//     enough to warrant its own file for this spike).
//   - `tools.by_name` — `Edit: DiffPanel`, `delete_file: PermissionPrompt`
//     (both named, both confirmed wired here), `Fallback: BashLine` for
//     every other scripted tool call (`Bash`, used throughout the fixture
//     content) — not one of this stage's named files either, but needed so
//     Bash tool-calls render at all instead of vanishing silently; kept
//     small and local rather than invented as a 10th named component.
//   - `ErrorPrimitive.Root` wraps `ErrorState.tsx` once per assistant
//     message (confirm that link in ErrorState.tsx's own header comment).
import { useEffect, useState, type FC } from "react";
import { Box, Text, useInput } from "ink";
import {
  MessagePrimitive,
  ErrorPrimitive,
  useAuiState,
  type ReasoningGroupComponent,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react-ink";
import { liveBulletStatus } from "@lia496/shared";
import { theme, GLYPH_USER, GLYPH_ASSISTANT, GLYPH_TOOL, STATUS_COLOR } from "../theme";
import { OUTPUT_LINE_CAP } from "../toolOutputCap";
import { MarkdownText } from "./Markdown";
import { DiffPanel } from "./DiffPanel";
import { PermissionPrompt } from "./PermissionPrompt";
import { ErrorState } from "./ErrorState";

// I6 (LIA-496 IB2) — cap raw tool output the same way Claude Code's own
// transcript does: a short head, then a "… +N lines" row instead of
// dumping the whole thing. `N` is always computed HERE from the raw result
// string's own line count — never read off a library prop (`DiffView` has
// no such field either, per D2's corrected diff-cap approach; BashLine's
// result is a plain string with no library surface at all, so this was
// always going to be local math either way). `OUTPUT_LINE_CAP` itself lives
// in `../toolOutputCap` — `committedBlocks.tsx`'s `<Static>` commit gate
// needs the exact same threshold (see that module's header comment), so
// it's the one shared source, not duplicated here.

// Exported (LIA-496 IB1 spike, `spike/approach-a.tsx`) so the
// prop-reconstruction candidate can reuse this EXACT leaf component instead
// of hand-duplicating it — the spike write-up itself lives in
// `spike/approach-a.tsx`/`spike/approach-b.tsx`'s own header comments (no
// separate `docs/decisions/` note exists for it; this comment previously
// pointed at one that was never actually created). Not otherwise a public
// API of this module; Messages.tsx's own wiring below still uses it as a
// plain local const.
//
// Known `<Static>` limitation (LIA-496 plan's own Risk #2, restated here
// since this component is the concrete case it warns about): the
// collapse/expand state below is local React state, so it only behaves
// once this instance is still in the DYNAMIC (not-yet-committed) region.
// A BashLine already committed into `<Static>` renders whatever
// expanded/collapsed state it had at commit time, frozen — ctrl+o pressed
// after that has nothing left to toggle for that line. Acceptable for this
// spike; noted in VERIFICATION.md, not silently glossed over.
export const BashLine: FC<ToolCallMessagePartProps> = (props) => {
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = STATUS_COLOR[liveBulletStatus(pending, isError)];
  const command = (props.args as { command?: string } | undefined)?.command ?? props.argsText;

  const resultText = pending ? "" : String(props.result);
  const resultLines = resultText.length > 0 ? resultText.split("\n") : [];
  const hiddenLineCount = Math.max(0, resultLines.length - OUTPUT_LINE_CAP);
  const capped = hiddenLineCount > 0;

  // Auto-expand on error — a capped error tail is exactly the thing a user
  // needs to see in full, not hide behind an extra keypress.
  //
  // `useState(isError)` alone is only an initializer: it's evaluated once
  // at mount, so a BashLine already mounted while `pending` (isError still
  // false) would never auto-expand when the error result later arrived on
  // that SAME live instance — only a fresh remount (e.g. at `<Static>`
  // commit time) would pick it up (code-review REVISE, LIA-496 IB2 round
  // 2). The effect below re-syncs `expanded` whenever `isError` flips to
  // true on an already-mounted instance, covering the live-streaming
  // window as well as the commit-time remount.
  const [expanded, setExpanded] = useState(isError);

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") setExpanded((prev) => !prev);
    },
    { isActive: capped },
  );

  const visibleLines = capped && !expanded ? resultLines.slice(0, OUTPUT_LINE_CAP) : resultLines;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {GLYPH_TOOL}{" "}
        </Text>
        <Text bold>{props.toolName}</Text>
        <Text>(</Text>
        <Text color={theme.dim}>{command}</Text>
        <Text>)</Text>
      </Box>
      <Box flexDirection="column">
        {pending ? (
          <Text color={theme.dim}>
            {"  "}running…
          </Text>
        ) : (
          <>
            {visibleLines.map((line, i) => (
              <Text key={i} color={theme.ink}>
                {"  "}
                {line}
              </Text>
            ))}
            {capped && !expanded ? (
              <Text color={theme.dim}>
                {"  "}… +{hiddenLineCount} lines · ctrl+o expand
              </Text>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
};

const ReasoningLine: FC<ReasoningMessagePartProps> = (props) => (
  <Text color={theme.dim} italic>
    {props.text}
  </Text>
);

// I9 (LIA-496 IB2) — no border. Borders are reserved for composer/
// permission/overlays (IB1 already established this for the outer frame;
// this is that same rule applied to inner content chrome). The "thinking"
// state stays legible without a box: an italic dim label line, same as
// `ReasoningLine`'s own italic-dim treatment for the reasoning text itself.
const ReasoningGroup: ReasoningGroupComponent = ({ endIndex, children }) => {
  const stillStreaming = useAuiState((s) => s.message.parts[endIndex]?.status?.type === "running");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.dim} italic>
        {stillStreaming ? "thinking…" : "thought"}
      </Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
};

// I8 (LIA-496 IB2) — no "you" label. The amber `GLYPH_USER` gutter mark
// already encodes speaker; a redundant text label restated the same fact a
// second time on every single message.
export const UserMessage: FC = () => (
  <Box flexDirection="row" marginBottom={1}>
    <Box width={2}>
      <Text color={theme.amber} bold>
        {GLYPH_USER}
      </Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
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

// I8 (LIA-496 IB2) — no "deus" label, same rationale as `UserMessage`
// above: `GLYPH_ASSISTANT`'s dim gutter mark already encodes speaker.
export const AssistantMessage: FC = () => (
  <Box flexDirection="row" marginBottom={1}>
    <Box width={2}>
      <Text color={theme.dim} bold>
        {GLYPH_ASSISTANT}
      </Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <ErrorPrimitive.Root>
        <ErrorState />
      </ErrorPrimitive.Root>
      <MessagePrimitive.Parts components={assistantPartComponents} unstable_showEmptyOnNonTextEnd={false} />
    </Box>
  </Box>
);
