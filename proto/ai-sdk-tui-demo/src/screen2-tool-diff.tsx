/**
 * LIA-494 throwaway prototype — screen 2 of 2 (diff-carrying tool result +
 * status glyph). Built as a fully custom Ink screen rendering FIXTURE data
 * directly, per the setup stage's own conclusion: @ai-sdk/tui's only public
 * export is `runAgentTUI`, which drives a live `agent`/`transport` loop —
 * there is no live tool-call stream to hook up here, and no need to fight
 * the library's internal (non-exported) `AgentTUIRenderer` duck-typing for a
 * static fixture demo. @ai-sdk/tui contributes nothing to this screen beyond
 * having been evaluated and ruled out as the right layer for it — the entire
 * rendering below is plain Ink (already a dependency of @ai-sdk/tui itself).
 *
 * Fixture shape and glyph logic are reused VERBATIM (not reinvented) from
 * Deus's own real, already-tested production code, read directly before
 * writing this file:
 *   - `TranscriptEntry`-shaped fixture (`{ id, kind: 'tool', text, status }`)
 *     and `ToolMessageProps` — deus-v2-mvp/.claude/worktrees/lia-474-diff-pipeline/
 *     src/cli/tui-v2/components/messages/ToolMessage.tsx
 *   - `ToolCallStatus = 'success' | 'error' | 'unknown'` — same worktree's
 *     src/agent-runtimes/types.ts:85
 *   - `statusGlyph()` exhaustive switch (success→✓/green, error→✗/red,
 *     unknown→?/yellow, `never`-checked default) — ToolMessage.tsx:65-82
 *   - `ToolResultContent = {type:'text'} | {type:'diff', diffContent, filename?}`
 *     and `parseDiffWithLineNumbers`/`DiffLine` — ToolResultDisplay.tsx:44-46,
 *     DiffRenderer.tsx
 * The regression case those files' own tests guard (LIA-474: a denied/failed
 * call must render ✗ and must NEVER also contain ✓) is reproduced below as
 * fixture #2 and asserted in a plain runtime check before rendering, not just
 * visually — see `assertNoFalsePositiveCheckmark` below.
 *
 * Simplifications made for this throwaway (stated, not silent): no
 * `themeManager`/`SemanticColors` (real prod's theme system isn't part of
 * this evaluation), no `CodeColorizer` syntax highlighting (irrelevant to
 * what's being evaluated — the glyph/diff contract), no `MaxSizedBox`
 * scroll-clamping (fixed small fixtures, no overflow risk in a demo).
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, render } from 'ink';

// ---------------------------------------------------------------------------
// Reused-verbatim types (see file header for exact source locations)
// ---------------------------------------------------------------------------

type ToolCallStatus = 'success' | 'error' | 'unknown';

interface TranscriptEntry {
  id: number;
  kind: 'tool';
  text: string;
  status: ToolCallStatus;
}

type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; diffContent: string; filename?: string };

interface ToolMessageProps {
  entry: TranscriptEntry;
  terminalWidth: number;
  isFirst?: boolean;
  result?: ToolResultContent;
}

// ---------------------------------------------------------------------------
// statusGlyph — ported verbatim (exhaustive switch, `never`-checked default,
// same three glyphs/colors) from ToolMessage.tsx:65-82. Only the color
// values change (plain ink color names instead of `themeManager`'s
// `SemanticColors` token object — no theme system in this throwaway).
// ---------------------------------------------------------------------------

function statusGlyph(status: ToolCallStatus): { glyph: string; color: string } {
  switch (status) {
    case 'success':
      return { glyph: '✓ ', color: 'green' }; // ✓
    case 'error':
      return { glyph: '✗ ', color: 'red' }; // ✗
    case 'unknown':
      return { glyph: '? ', color: 'yellow' };
    default: {
      const unhandled: never = status;
      void unhandled;
      return { glyph: '? ', color: 'yellow' };
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal diff line parser — same hunk/add/del/context split as
// `parseDiffWithLineNumbers` in DiffRenderer.tsx, trimmed of line-number
// bookkeeping this demo doesn't render (kept: type + content, enough to
// prove the diff payload renders with correct +/- coloring).
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  content: string;
}

function parseDiff(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (/^@@ /.test(line)) {
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) result.push({ type: 'add', content: line.slice(1) });
    else if (line.startsWith('-')) result.push({ type: 'del', content: line.slice(1) });
    else if (line.startsWith(' ')) result.push({ type: 'context', content: line.slice(1) });
  }
  return result;
}

const DiffRenderer: React.FC<{ diffContent: string; filename?: string }> = ({
  diffContent,
  filename,
}) => {
  const lines = parseDiff(diffContent);
  if (lines.length === 0) {
    return (
      <Box padding={1}>
        <Text dimColor>No changes detected.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {filename && (
        <Text dimColor underline>
          {filename}
        </Text>
      )}
      {lines.map((line, i) => {
        if (line.type === 'hunk') {
          return (
            <Text key={i} color="cyan" dimColor>
              {line.content}
            </Text>
          );
        }
        const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
        const color = line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : undefined;
        return (
          <Text key={i} color={color}>
            {prefix}
            {line.content}
          </Text>
        );
      })}
    </Box>
  );
};

const ToolResultDisplay: React.FC<{ result: ToolResultContent }> = ({ result }) => {
  switch (result.type) {
    case 'text':
      if (result.text.trim() === '') return null;
      return <Text wrap="wrap">{result.text}</Text>;
    case 'diff':
      return <DiffRenderer diffContent={result.diffContent} filename={result.filename} />;
    default: {
      const unhandled: never = result;
      void unhandled;
      return null;
    }
  }
};

const ToolMessage: React.FC<ToolMessageProps> = ({
  entry,
  terminalWidth,
  isFirst = true,
  result,
}) => {
  const { glyph, color } = statusGlyph(entry.status);
  return (
    <Box flexDirection="column" width={terminalWidth}>
      <Box
        borderStyle="round"
        borderColor="gray"
        borderTop={isFirst}
        borderBottom={!result}
        paddingX={1}
      >
        <Text color={color}>{glyph}</Text>
        <Text bold wrap="truncate-end">
          {entry.text}
        </Text>
      </Box>
      {result && (
        <Box
          borderStyle="round"
          borderColor="gray"
          borderTop={false}
          paddingX={1}
          flexDirection="column"
        >
          <ToolResultDisplay result={result} />
        </Box>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Fixtures — exercising all three statuses. Fixture #2 is the explicit
// LIA-474 regression case: a DENIED/failed write must show ✗ and must never
// also contain ✓, even though it still carries a (rejected) diff payload.
// ---------------------------------------------------------------------------

const SUCCESS_DIFF = `--- a/src/utils/math.ts
+++ b/src/utils/math.ts
@@ -1,5 +1,7 @@
 export function add(a: number, b: number): number {
-  return a + b;
+  return a + b; // TODO: overflow check
 }

-export function sub(a: number, b: number): number {
+export function subtract(a: number, b: number): number {
   return a - b;
 }
+
+export function multiply(a: number, b: number): number {
+  return a * b;
+}`;

const DENIED_DIFF = `--- a/src/config/secrets.ts
+++ b/src/config/secrets.ts
@@ -1,3 +1,3 @@
 export const config = {
-  apiKey: process.env.API_KEY,
+  apiKey: 'sk-live-hardcoded-example-do-not-use',
 };`;

const fixtures: Array<{ entry: TranscriptEntry; result?: ToolResultContent }> = [
  {
    entry: { id: 1, kind: 'tool', text: 'write_file(src/utils/math.ts)', status: 'success' },
    result: { type: 'diff', diffContent: SUCCESS_DIFF, filename: 'src/utils/math.ts' },
  },
  {
    entry: {
      id: 2,
      kind: 'tool',
      text: 'write_file(src/config/secrets.ts) — DENIED by user',
      status: 'error',
    },
    result: { type: 'diff', diffContent: DENIED_DIFF, filename: 'src/config/secrets.ts' },
  },
  {
    entry: { id: 3, kind: 'tool', text: 'bash(rm -rf tmp/)', status: 'unknown' },
    result: {
      type: 'text',
      text: 'No correlated result — connection dropped before the daemon ack arrived.',
    },
  },
];

// Runtime guard (not just a visual eyeball check): the LIA-474 regression
// case must never render both glyphs. Cheap to assert directly since the
// glyph mapping is a pure function.
function assertNoFalsePositiveCheckmark() {
  for (const { entry } of fixtures) {
    const { glyph } = statusGlyph(entry.status);
    if (entry.status !== 'success' && glyph.includes('✓')) {
      throw new Error(
        `false-positive green checkmark on status=${entry.status} (entry ${entry.id})`,
      );
    }
  }
}
assertNoFalsePositiveCheckmark();

const App: React.FC = () => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Keep the process alive briefly so a terminal recorder has a stable
    // frame to capture, then exit cleanly (this is a static fixture render,
    // not an interactive loop — no input is read).
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    const timeout = setTimeout(() => process.exit(0), 8000);
    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
  }, []);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold underline>
          LIA-494 — diff-carrying tool result + status glyph (screen 2/2)
        </Text>
      </Box>
      {fixtures.map((f, i) => (
        <Box key={f.entry.id} marginBottom={1}>
          <ToolMessage
            entry={f.entry}
            terminalWidth={78}
            isFirst
            result={f.result}
          />
        </Box>
      ))}
      <Text dimColor>
        exiting in {8 - tick}s — success=green ✓, denied/error=red ✗ (never ✓), unknown=yellow ?
      </Text>
    </Box>
  );
};

render(<App />);
