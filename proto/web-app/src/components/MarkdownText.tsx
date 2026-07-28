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
import type { FC } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { CodeBlock } from "./CodeBlock";

const markdownComponents = { code: CodeBlock };

// MarkdownTextPrimitive takes no `text`/`children` prop — confirmed by
// reading @assistant-ui/react-markdown/dist/primitives/MarkdownText.js
// directly: it calls `useMessagePartText()` internally, reading the
// current text part straight from the ambient MessagePart context that
// `MessagePrimitive.Parts` establishes before invoking `components.Text`.
// This component is that `components.Text` value (wired in
// Thread.tsx's AssistantMessage), not a standalone text renderer — it
// only exists inside that context.
export const MarkdownText: FC = () => {
  return <MarkdownTextPrimitive className="s-ast serif" smooth={false} components={markdownComponents} />;
};
