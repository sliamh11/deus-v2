/**
 * LIA-494 throwaway prototype — screen 2 of 2 (diff-carrying tool result +
 * status bullet). Built as a fully custom Ink screen rendering FIXTURE data
 * directly, per the setup stage's own conclusion: @ai-sdk/tui's only public
 * export is `runAgentTUI`, which drives a live `agent`/`transport` loop —
 * there is no live tool-call stream to hook up here, and no need to fight
 * the library's internal (non-exported) `AgentTUIRenderer` duck-typing for a
 * static fixture demo. @ai-sdk/tui contributes nothing to this screen beyond
 * having been evaluated and ruled out as the right layer for it — the entire
 * rendering below is plain Ink (already a dependency of @ai-sdk/tui itself).
 * This is unchanged from round 2; see FINDINGS.md.
 *
 * ROUND 3 (LIA-494 comparison round, this file): redesigned to match the
 * Claude Code design-language spec (`spec-and-plan.md`, "Claude Code Design
 * Language Spec" + the `@ai-sdk/tui` "Diff screen" application plan). All of
 * this styling is CONSUMER-OWNED Ink code — none of it comes from
 * @ai-sdk/tui, which supplies no diff/status-rendering primitives at all
 * (confirmed in round 2; the library's only export is the live-loop runner).
 * Concretely, per the plan:
 *   - named Ink colors ('green'/'red'/'yellow'/'cyan'/'gray') replaced by
 *     the shared hex token object (`TOKENS`);
 *   - `statusGlyph()` (three glyph families: ✓/✗/?) replaced by
 *     `toolCallState()`, an exhaustive switch that always returns the
 *     canonical `⏺` bullet plus a semantic color — this is the "stateful
 *     bullet" convention, not a glyph-family switch;
 *   - the regression guard is updated to check for a false-positive
 *     *success color* on a non-success status, since checking for a
 *     checkmark glyph is meaningless once every state renders `⏺`;
 *   - `parseDiff()` extended to track old/new line numbers per hunk, and
 *     the renderer grew context folding + a deterministic truncation cap —
 *     the "line-numbered comparison target" required by the spec;
 *   - the diff filename is rendered through a real OSC 8 hyperlink instead
 *     of underline-only styling;
 *   - `ToolMessage` collapsed from two boxes (header box + result box) to
 *     one: a plain (unboxed) bold tool-call header line followed by a
 *     single rounded result panel — neutral border for non-error output,
 *     error-tinted border for denied/failed output;
 *   - the denied-diff regression fixture now renders an explicit
 *     "Proposed changes — not applied" label inside its panel;
 *   - the prototype heading and the visible capture-exit countdown are
 *     removed from `App` — the capture should read like a real transcript,
 *     not an annotated demo.
 *
 * Fixture shape and glyph/diff logic are still reused VERBATIM in substance
 * (not reinvented) from Deus's own real, already-tested production code,
 * read directly before writing round 2's version of this file:
 *   - `TranscriptEntry`-shaped fixture (`{ id, kind: 'tool', ..., status }`)
 *     and `ToolMessageProps` — deus-v2-mvp/.claude/worktrees/lia-474-diff-pipeline/
 *     src/cli/tui-v2/components/messages/ToolMessage.tsx
 *   - `ToolCallStatus = 'success' | 'error' | 'unknown'` — same worktree's
 *     src/agent-runtimes/types.ts:85
 *   - the exhaustive `never`-checked status switch — ToolMessage.tsx:65-82
 *     (glyph choice itself is now spec-driven, not ported; the exhaustive-
 *     switch-with-never-default *shape* is preserved)
 *   - `ToolResultContent = {type:'text'} | {type:'diff', diffContent, filename?}`
 *     and `parseDiffWithLineNumbers`/`DiffLine` — ToolResultDisplay.tsx:44-46,
 *     DiffRenderer.tsx
 * The regression case those files' own tests guard (LIA-474: a denied/failed
 * call must never render success styling) is reproduced below as fixture #2
 * and asserted in a plain runtime check before rendering, not just visually
 * — see `assertNoFalsePositiveSuccessColor` below.
 *
 * Simplifications made for this throwaway (stated, not silent): no
 * `themeManager`/`SemanticColors` (real prod's theme system isn't part of
 * this evaluation — this file's `TOKENS` object is the comparison-round
 * spec's tokens, not prod's), no `CodeColorizer` syntax highlighting
 * (irrelevant to what's being evaluated — the bullet/diff contract), no
 * `MaxSizedBox` scroll-clamping component (the deterministic `maxLines` cap
 * below is a much smaller stand-in, sufficient for fixed small fixtures).
 */

import path from 'node:path';
import React, { useEffect } from 'react';
import { Box, Text, render } from 'ink';

// ---------------------------------------------------------------------------
// Shared design tokens (Claude Code design-language spec, "Color system").
// Hex values passed directly to Ink rather than named colors, per the
// spec's "Reasoned extension" under Implementation rules.
// ---------------------------------------------------------------------------

const TOKENS = {
  surface: { dark: '#141413', light: '#FAF9F5' },
  text: { onLight: '#141413', muted: '#B0AEA5' },
  accent: { primary: '#D97757', info: '#6A9BCC', green: '#788C5D' },
  semantic: { success: '#788C5D', warning: '#C49A52', error: '#B95C50' },
  border: { neutral: '#B0AEA5' },
} as const;

// ---------------------------------------------------------------------------
// Reused-verbatim-in-substance types (see file header for exact source
// locations). `TranscriptEntry` now separates `toolName` from
// `argsSummary` so the canonical line shape (`⏺ ToolName(args)`, bold name
// only) can be rendered without re-parsing a combined string.
// ---------------------------------------------------------------------------

type ToolCallStatus = 'success' | 'error' | 'unknown';

interface TranscriptEntry {
  id: number;
  kind: 'tool';
  toolName: string;
  argsSummary: string;
  status: ToolCallStatus;
}

type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; diffContent: string; filename?: string };

interface ToolMessageProps {
  entry: TranscriptEntry;
  terminalWidth: number;
  result?: ToolResultContent;
}

// ---------------------------------------------------------------------------
// toolCallState — spec-driven replacement for the old `statusGlyph()`.
// Every status renders the SAME `⏺` bullet (the "stateful bullet"
// convention from the spec's "Tool-call typography and glyphs" section);
// only the color changes. Exhaustive switch with a `never`-checked default,
// same defensive shape as the ported original.
// ---------------------------------------------------------------------------

function toolCallState(status: ToolCallStatus): { glyph: string; color: string } {
  switch (status) {
    case 'success':
      return { glyph: '⏺', color: TOKENS.semantic.success };
    case 'error':
      return { glyph: '⏺', color: TOKENS.semantic.error };
    case 'unknown':
      return { glyph: '⏺', color: TOKENS.text.muted };
    default: {
      const unhandled: never = status;
      void unhandled;
      return { glyph: '⏺', color: TOKENS.text.muted };
    }
  }
}

// ---------------------------------------------------------------------------
// OSC 8 hyperlink helper (spec: "For file paths" rules). Resolves relative
// paths against cwd, emits a percent-encoded `file://` target, and falls
// back to plain text when stdout isn't a TTY (no reliable way to detect
// terminal OSC 8 support beyond that from Node, so this is a "reasoned
// extension" heuristic, not a confirmed capability probe). Color is applied
// by the caller, separately from the hyperlink escape — hyperlink
// correctness must not depend on text color.
// ---------------------------------------------------------------------------

function hyperlinkPath(label: string): string {
  const supportsOSC8 = Boolean(process.stdout.isTTY);
  if (!supportsOSC8) return label;
  const absolute = path.isAbsolute(label) ? label : path.resolve(process.cwd(), label);
  // ROUND-3 FIX (codex review finding #3): `encodeURI` leaves `#` and `?`
  // unescaped, which produces a broken OSC 8 `file://` target for any path
  // containing them. Percent-encode each path segment individually (matches
  // screen1-permission.tsx's `toFileUrl`) so every reserved character in a
  // segment is escaped while `/` separators are preserved.
  const encoded = absolute.split(path.sep).map(encodeURIComponent).join('/');
  const url = encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
  return `]8;;${url}${label}]8;;`;
}

// ---------------------------------------------------------------------------
// Diff parsing — extended from the round-2 minimal parser to retain old/new
// line numbers per hunk (spec: "line-numbered comparison target"), plus a
// context-folding pass and a deterministic truncation cap (spec's
// "Confirmed: ... line-number handling, and truncation").
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  content: string;
  oldLine?: number;
  newLine?: number;
}

type RenderLine = DiffLine | { type: 'folded'; count: number };

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiff(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1), oldLine });
      oldLine++;
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', content: line.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return result;
}

/** Collapse long runs of consecutive context lines to `contextLines` on
 *  each side of a change, folding the middle into a single muted marker. */
function foldContext(lines: DiffLine[], contextLines: number): RenderLine[] {
  const out: RenderLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'context') {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === 'context') j++;
    const run = lines.slice(i, j);
    if (run.length <= contextLines * 2) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, contextLines));
      out.push({ type: 'folded', count: run.length - contextLines * 2 });
      out.push(...run.slice(run.length - contextLines));
    }
    i = j;
  }
  return out;
}

/** Deterministic cap so a runaway fixture can't blow out the panel height. */
function truncate(lines: RenderLine[], maxLines: number): { shown: RenderLine[]; hiddenCount: number } {
  if (lines.length <= maxLines) return { shown: lines, hiddenCount: 0 };
  return { shown: lines.slice(0, maxLines), hiddenCount: lines.length - maxLines };
}

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 40;

function renderDiffLine(
  line: RenderLine,
  key: number,
  gutterWidth: number,
  notApplied: boolean,
): React.ReactElement {
  if (line.type === 'folded') {
    return (
      <Text key={key} color={TOKENS.text.muted}>
        {' '.repeat(gutterWidth * 2 + 1)}⋯ {line.count} unchanged line{line.count === 1 ? '' : 's'} ⋯
      </Text>
    );
  }
  if (line.type === 'hunk') {
    return (
      <Text key={key} color={TOKENS.accent.info}>
        {line.content}
      </Text>
    );
  }
  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  // ROUND-3 FIX (codex review finding #1): a denied/failed call's diff must
  // never render success (or its own error) coloring on individual lines —
  // nothing was actually applied, so tinting `+` lines green is a false
  // positive regardless of the panel border/label already saying so.
  // Collapse add/del coloring to text.muted whenever notApplied is true;
  // only an actually-applied (`success`) diff gets add=green/del=red.
  const color = notApplied
    ? TOKENS.text.muted
    : line.type === 'add'
      ? TOKENS.semantic.success
      : line.type === 'del'
        ? TOKENS.semantic.error
        : undefined;
  const oldNum = line.oldLine ? String(line.oldLine).padStart(gutterWidth) : ' '.repeat(gutterWidth);
  const newNum = line.newLine ? String(line.newLine).padStart(gutterWidth) : ' '.repeat(gutterWidth);
  return (
    <Text key={key}>
      <Text color={TOKENS.text.muted}>
        {oldNum} {newNum}{' '}
      </Text>
      <Text color={color}>
        {prefix}
        {line.content}
      </Text>
    </Text>
  );
}

// ---------------------------------------------------------------------------
// DiffRenderer — spec: file path as OSC 8 hyperlink + compact +/- counts
// above the diff; "Proposed changes — not applied" label for a denied or
// failed operation's diff (never inherits success styling); line-numbered
// gutter in text.muted; context folding + truncation notices in text.muted.
// ---------------------------------------------------------------------------

const DiffRenderer: React.FC<{ diffContent: string; filename?: string; notApplied: boolean }> = ({
  diffContent,
  filename,
  notApplied,
}) => {
  const rawLines = parseDiff(diffContent);
  if (rawLines.length === 0) {
    return <Text color={TOKENS.text.muted}>No changes detected.</Text>;
  }

  const added = rawLines.filter((l) => l.type === 'add').length;
  const deleted = rawLines.filter((l) => l.type === 'del').length;
  const maxLineNo = rawLines.reduce(
    (max, l) => Math.max(max, l.oldLine ?? 0, l.newLine ?? 0),
    1,
  );
  const gutterWidth = String(maxLineNo).length;

  const folded = foldContext(rawLines, CONTEXT_LINES);
  const { shown, hiddenCount } = truncate(folded, MAX_DIFF_LINES);

  return (
    <Box flexDirection="column">
      {filename && (
        <Box marginBottom={notApplied ? 0 : 1}>
          <Text>{hyperlinkPath(filename)}</Text>
          {/* Same false-positive-success fix as renderDiffLine: the compact
              +N/-M stat line is just as much "success styling" as the diff
              body, and codex finding #1 called it out by line number. */}
          <Text color={notApplied ? TOKENS.text.muted : TOKENS.semantic.success}> +{added}</Text>
          <Text color={notApplied ? TOKENS.text.muted : TOKENS.semantic.error}> -{deleted}</Text>
        </Box>
      )}
      {notApplied && (
        <Box marginBottom={1}>
          <Text bold color={TOKENS.semantic.warning}>
            Proposed changes — not applied
          </Text>
        </Box>
      )}
      {shown.map((line, i) => renderDiffLine(line, i, gutterWidth, notApplied))}
      {hiddenCount > 0 && (
        <Text color={TOKENS.text.muted}>… {hiddenCount} more lines truncated …</Text>
      )}
    </Box>
  );
};

const ToolResultDisplay: React.FC<{ result: ToolResultContent; status: ToolCallStatus }> = ({
  result,
  status,
}) => {
  switch (result.type) {
    case 'text':
      if (result.text.trim() === '') return null;
      return <Text wrap="wrap">{result.text}</Text>;
    case 'diff':
      return (
        <DiffRenderer
          diffContent={result.diffContent}
          filename={result.filename}
          notApplied={status !== 'success'}
        />
      );
    default: {
      const unhandled: never = result;
      void unhandled;
      return null;
    }
  }
};

// ---------------------------------------------------------------------------
// ToolMessage — spec: "a compact bold tool-call header followed by one
// rounded result panel" (collapsed from round 2's two-box layout). Neutral
// border for non-error output, error-tinted border for denied/failed
// output. Header line follows the canonical shape `⏺ ToolName(args)`.
// ---------------------------------------------------------------------------

const ToolMessage: React.FC<ToolMessageProps> = ({ entry, terminalWidth, result }) => {
  const state = toolCallState(entry.status);
  const borderColor = entry.status === 'error' ? TOKENS.semantic.error : TOKENS.border.neutral;

  return (
    <Box flexDirection="column" width={terminalWidth}>
      <Box>
        <Text color={state.color}>{state.glyph} </Text>
        <Text bold>{entry.toolName}</Text>
        <Text>({entry.argsSummary})</Text>
      </Box>
      {result && (
        <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
          <ToolResultDisplay result={result} status={entry.status} />
        </Box>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Fixtures — exercising all three statuses (spec's shared-comparison states
// 5-7: successful diff, denied/failed diff with no success styling,
// indeterminate/disconnected tool result). Fixture #2 is the explicit
// LIA-474 regression case: a DENIED/failed call must never render success
// styling, even though it still carries a (rejected) diff payload.
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
    entry: {
      id: 1,
      kind: 'tool',
      toolName: 'write_file',
      argsSummary: 'src/utils/math.ts',
      status: 'success',
    },
    result: { type: 'diff', diffContent: SUCCESS_DIFF, filename: 'src/utils/math.ts' },
  },
  {
    entry: {
      id: 2,
      kind: 'tool',
      toolName: 'write_file',
      argsSummary: 'src/config/secrets.ts',
      status: 'error',
    },
    result: { type: 'diff', diffContent: DENIED_DIFF, filename: 'src/config/secrets.ts' },
  },
  {
    entry: {
      id: 3,
      kind: 'tool',
      toolName: 'bash',
      argsSummary: 'rm -rf tmp/',
      status: 'unknown',
    },
    result: {
      type: 'text',
      text: 'No correlated result — connection dropped before the daemon ack arrived.',
    },
  },
];

// Runtime guard (not just a visual eyeball check): the LIA-474 regression
// case must never render success styling. Checking for a checkmark GLYPH
// (round 2's guard) is no longer meaningful now that every status renders
// the same `⏺` bullet — the guard now checks the resolved COLOR instead.
function assertNoFalsePositiveSuccessColor() {
  for (const { entry } of fixtures) {
    const { color } = toolCallState(entry.status);
    if (entry.status !== 'success' && color === TOKENS.semantic.success) {
      throw new Error(
        `false-positive success color on status=${entry.status} (entry ${entry.id})`,
      );
    }
  }
}
assertNoFalsePositiveSuccessColor();

const App: React.FC = () => {
  useEffect(() => {
    // Keep the process alive briefly so a terminal recorder has a stable
    // frame to capture, then exit cleanly (this is a static fixture render,
    // not an interactive loop — no input is read). No visible countdown per
    // the redesign plan: process-lifetime mechanics stay invisible.
    const timeout = setTimeout(() => process.exit(0), 8000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <Box flexDirection="column">
      {fixtures.map((f) => (
        <Box key={f.entry.id} marginBottom={1}>
          <ToolMessage entry={f.entry} terminalWidth={78} result={f.result} />
        </Box>
      ))}
    </Box>
  );
};

render(<App />);
