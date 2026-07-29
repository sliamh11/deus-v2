// LIA-496 — MarkdownText.tsx <- AssistantMessage's MessagePrimitive.Parts
// `components.Text` override (wired in Thread.tsx's AssistantMessage
// component). Uses @assistant-ui/react-markdown's MarkdownTextPrimitive,
// with a `components.code` override that renders CodeBlock.tsx — THIS
// LINK is the one a prior review round flagged as easy to miss (the
// LIA-471/473 CodeColorizer failure mode: a component that renders but is
// never wired into its call site). Confirmed real by construction: the
// `components` object literal below is passed directly to
// MarkdownTextPrimitive's own `components` prop, which
// (node_modules/@assistant-ui/react-markdown/dist/primitives/
// MarkdownText.d.ts, confirmed by reading it directly) extends plain
// react-markdown `Options["components"]` — the standard `code`/`pre`/etc.
// override map, not a separate registration step.
//
// WB1 (LIA-496 review-fix) — W2 stream-head cursor + pre-first-token
// shimmer. `Text: MarkdownText` (Thread.tsx's messageComponents) makes
// this component the actual `TextMessagePartComponent` — confirmed by
// reading MessagePartComponentTypes.d.ts directly:
// `TextMessagePartProps = MessagePartState & TextMessagePart`, so
// `MessagePrimitive.Parts` invokes it WITH `{ text, status, ... }` as real
// props, not a slot with no data (it previously just ignored them and
// read nothing). `status.type === "running"` is the live, per-part
// streaming signal (same field `MessagePartPrimitive.InProgress` gates on
// internally — confirmed by reading
// @assistant-ui/core/dist/react/primitives/messagePart/
// MessagePartInProgress.js: `s.part.status.type === "running"`), so the
// shimmer/cursor toggle below is driven by real reactive state — zero
// setTimeout/setInterval, the exact hand-rolled-timer mistake plan-review
// corrected. Text length 0 while running = nothing has streamed in yet
// (the gap between the message appending and the first chunk arriving,
// currently silent) -> shimmer. Non-empty while running -> real content +
// a cursor at the stream head. Neither state once running is false.
import type { FC } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { CodeBlock } from "./CodeBlock";

const markdownComponents = { code: CodeBlock };

// MarkdownTextPrimitive itself takes no `text`/`children` prop — confirmed
// by reading @assistant-ui/react-markdown/dist/primitives/MarkdownText.js
// directly: it calls `useMessagePartText()` internally, reading the
// current text part straight from the ambient MessagePart context that
// `MessagePrimitive.Parts` establishes before invoking `components.Text`.
// This component receives the SAME part as real props (per the header
// comment above) purely to drive the shimmer/cursor decision; the actual
// markdown rendering still goes through the primitive's own internal read.
export const MarkdownText: FC<TextMessagePartProps> = ({ text, status }) => {
  const isRunning = status.type === "running";

  if (isRunning && text.length === 0) {
    return <div className="s-shimmer" aria-hidden="true" />;
  }

  return (
    <div className="s-stream-wrap">
      <MarkdownTextPrimitive className="s-ast serif" smooth={false} components={markdownComponents} />
      {isRunning && <span className="s-cursor" aria-hidden="true" />}
    </div>
  );
};
