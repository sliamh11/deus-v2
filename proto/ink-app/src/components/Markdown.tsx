// LIA-496 — small hand-rolled Markdown subset renderer for the Ink target
// (paragraphs, bold/italic, inline code, lists, headings — the actual
// subset shared/src/fixtures/conversations.ts's scripted turns use; not a
// general-purpose Markdown engine). `ink-markdown` was probed at S0 and
// found unusable under ink@6/react@19 (top-level-await/CJS conflict, see
// SETUP-NOTES.md §7) — this was always going to be hand-rolled either way.
//
// Wired as `Messages.tsx`'s `AssistantMessage`'s `MessagePrimitive.Parts`
// `components.Text` override — confirmed by reading that file's own JSX,
// not assumed. Fenced code blocks route to `TokenLine.tsx` (confirm that
// link there, not here).
import type { FC } from "react";
import { Box, Text } from "ink";
import type { TextMessagePartProps } from "@assistant-ui/react-ink";
import { theme } from "../theme";
import { TokenLine } from "./TokenLine";

type InlineSpan = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

// `` `code` `` | `**bold**` | `*italic*` / `_italic_`, in that priority
// order (code first so backticked text is never re-parsed for */_).
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;

function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) spans.push({ text: text.slice(lastIndex, index) });
    if (match[1] !== undefined) spans.push({ text: match[1], code: true });
    else if (match[2] !== undefined) spans.push({ text: match[2], bold: true });
    else if (match[3] !== undefined) spans.push({ text: match[3], italic: true });
    else if (match[4] !== undefined) spans.push({ text: match[4], italic: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) spans.push({ text: text.slice(lastIndex) });
  return spans;
}

const InlineText: FC<{ line: string }> = ({ line }) => (
  <Text>
    {parseInline(line).map((span, i) =>
      span.code ? (
        <Text key={i} color={theme.amber}>
          {span.text}
        </Text>
      ) : (
        <Text key={i} bold={span.bold} italic={span.italic}>
          {span.text}
        </Text>
      ),
    )}
  </Text>
);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
const FENCE_RE = /^```\s*(\S*)\s*$/;

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; lang: string | undefined; code: string }
  | { type: "paragraph"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1]!.length, text: headingMatch[2]! });
      i += 1;
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && LIST_RE.test(lines[i] ?? "")) {
        const m = LIST_RE.exec(lines[i] ?? "");
        items.push(m?.[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block
    // type.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !FENCE_RE.test(lines[i] ?? "") &&
      !HEADING_RE.test(lines[i] ?? "") &&
      !LIST_RE.test(lines[i] ?? "")
    ) {
      paraLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

export const MarkdownText: FC<TextMessagePartProps> = ({ text }) => {
  if (!text) return null;
  const blocks = parseBlocks(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <Box key={i} marginBottom={1}>
                <Text bold color={theme.ink}>
                  {"#".repeat(block.level)} {block.text}
                </Text>
              </Box>
            );
          case "list":
            return (
              <Box key={i} flexDirection="column" marginBottom={1}>
                {block.items.map((item, j) => (
                  <Box key={j}>
                    <Text color={theme.dim}>{"  - "}</Text>
                    <InlineText line={item} />
                  </Box>
                ))}
              </Box>
            );
          case "code":
            return (
              <Box key={i} marginBottom={1}>
                <TokenLine code={block.code} lang={block.lang} />
              </Box>
            );
          case "paragraph":
          default:
            return (
              <Box key={i} marginBottom={1}>
                <InlineText line={block.text} />
              </Box>
            );
        }
      })}
    </Box>
  );
};
