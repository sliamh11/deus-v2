#!/usr/bin/env node
/**
 * LIA-494 prototype — round 4: the FULL Claude Code app-shell mimicry.
 * Round 5 (this pass) pushes the same file to Ink's actual engineering
 * ceiling, since round 3 already confirmed `@ai-sdk/tui`'s public surface
 * is just `runAgentTUI` + option types — there is no additional *library*
 * API to lean on, so "take it to its limits" means pure Ink capability:
 *
 *   1. `<Static>`-backed scrollback: settled transcript entries (a finished
 *      user turn, a completed assistant message, a resolved tool call) move
 *      into a `<Static>` list and are written to real terminal scrollback
 *      exactly once — never re-painted again. Only the genuinely-still-
 *      changing region (spinner, an in-flight tool call, the permission
 *      countdown, the composer) re-renders in the live Ink tree below it.
 *      This mirrors Claude Code's default streaming-to-scrollback mode
 *      specifically (not `CLAUDE_CODE_NO_FLICKER`'s alternate-screen mode,
 *      which is a different rendering strategy `<Static>` isn't for).
 *   2. A genuinely real, raw-mode `useInput`-driven composer: the opening
 *      user message is no longer delivered by a script directly overwriting
 *      a `composerText` prop. `Composer` owns its own text as internal
 *      state, mutated *only* through its `useInput` handler (character
 *      append, backspace/delete, Enter to submit) — the identical shape as
 *      round 4's real `PermissionPrompt`. For unattended recording it keeps
 *      a fallback exactly parallel to the permission prompt's auto-deny
 *      countdown: if no real key lands within `autoFillDelayMs`, the same
 *      internal state is advanced by a timer instead of a keystroke — not a
 *      second parallel "fake typing" mechanism. See `Composer` below for
 *      the verified-real-keystroke test (tmux `send-keys` + capture-pane).
 *   3. Real reactive resize: `useStdout()` + its `'resize'` event (Ink's
 *      own `Ink` instance already listens for this internally to redo yoga
 *      layout — confirmed by reading `node_modules/ink/build/ink.js`) drive
 *      a `useTerminalSize()` hook that this shell reads explicitly, so
 *      bordered panels and the live column-count readout in the header
 *      visibly resize, not just implicitly reflow via yoga's own auto
 *      layout. Verified by resizing a real tmux pane mid-run.
 *
 * Prior rounds only redesigned isolated components (`screen1-permission.tsx`
 * alone, `screen2-tool-diff.tsx` alone) onto the Claude Code design-language
 * spec. This file composes an entire shell — header/status bar, spinner,
 * multi-turn streamed transcript, an in-flow tool call with a diff, an
 * INLINE permission prompt that genuinely interrupts a live session and then
 * lets it continue, a footer, and a composer — into one runnable Ink app
 * driven by a single scripted-but-realistic fixture conversation, so a
 * recording of it plays out like a real session end to end rather than a
 * gallery of disconnected screenshots.
 *
 * Library-honesty note (unchanged conclusion from rounds 1-3, restated here
 * because this file is the one meant to be watched as "the shell"): this is
 * a fully custom Ink app. `@ai-sdk/tui`'s own harness, `runAgentTUI`, was
 * spiked in round 3 (`transport-runner-spike.tsx`) and found structurally
 * unsuitable — no session-continuity hook and a strictly binary approval
 * primitive (`{approved: boolean; reason?}`, no `allow_always`) — so it is
 * not used here either. `@ai-sdk/tui` contributes nothing to this file
 * beyond pulling in Ink as a transitive dependency, same as screens 1 and 2.
 *
 * Reuse note: `screen1-permission.tsx` and `screen2-tool-diff.tsx` both end
 * with a top-level `render(<App />)` call and are not structured as
 * importable modules (no exports), so direct import isn't practical here —
 * importing either for its side effect would immediately mount a second,
 * unrelated Ink tree. Instead this file closely mirrors their approach:
 * the same `TOKENS` hex palette, the same ported-verbatim permission
 * decision logic (`permissionListKeyToResult`, hard-clamped cursor bounds,
 * the `PermissionPrompt` panel shape, the ref-based auto-deny countdown
 * fix from round 3's code review) from `screen1-permission.tsx`, and the
 * same diff-rendering pipeline (`toolCallState`, `parseDiff`, `foldContext`,
 * `truncate`, `renderDiffLine`, `DiffRenderer`, the `notApplied` false-
 * positive-styling guard from round 3's code review) from
 * `screen2-tool-diff.tsx`. Neither screen's file is modified.
 *
 * What's scripted vs. what's real: the *conversation content* (the fixed
 * "date formatter" scenario: tool calls, diff, permission request, test
 * results) is a fixture — there is no live model or daemon behind it,
 * exactly like screens 1 and 2. The *opening user message's delivery* is
 * genuinely real raw-mode keyboard input with a scripted-content fallback
 * (see point 2 above) — a live typist's own words are what gets submitted
 * and echoed into the transcript; only the assistant's scripted reply
 * afterward still narrates the fixed date-formatter scenario regardless of
 * what was actually typed, since this remains a fixture demo, not a live
 * agent. Everything else about the *rendering* is genuinely live: assistant
 * text is streamed chunk by chunk through real React state updates (not
 * printed as a static block), the spinner and its gerund word actually
 * rotate on independent timers, and the permission prompt is a real
 * `useInput`-driven Ink component — a person can press 1/2/3 or
 * arrows+Enter to resolve it, or let its unattended 15s auto-deny countdown
 * resolve it (mirroring round 3's `screen1-autodeny-fix` proof that the
 * countdown genuinely fires), and the script continues into a real,
 * different branch (denied vs. approved) depending on what actually
 * happened.
 */
import path from 'node:path';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout, Static, type Key } from 'ink';

// ---------------------------------------------------------------------------
// Claude Code design-language tokens (spec-and-plan.md "Color system").
// Same hex values as screen1/screen2's TOKENS objects, merged to the set
// this shell actually uses.
// ---------------------------------------------------------------------------

const TOKENS = {
  textMuted: '#B0AEA5',
  accentPrimary: '#D97757',
  accentInfo: '#6A9BCC',
  semanticSuccess: '#788C5D',
  semanticWarning: '#C49A52',
  semanticError: '#B95C50',
  borderNeutral: '#B0AEA5',
} as const;

// ---------------------------------------------------------------------------
// Real reactive resize. `Ink`'s own instance (`node_modules/ink/build/ink.js`
// `constructor`/`resized`) already listens for `stdout`'s `'resize'` event
// and recalculates the yoga root layout — but that alone only reflows nodes
// whose size is *implicitly* relative (percentage/flex). To make the shell
// visibly, explicitly reflow (bordered panel widths, a live column-count
// readout) this hook subscribes to the same event itself and hands the
// current terminal size down as real React state, so a resize produces a
// genuine re-render with new width props, not just yoga's own internal
// relayout of unrelated nodes.
// ---------------------------------------------------------------------------

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout.columns || DEFAULT_COLUMNS,
    rows: stdout.rows || DEFAULT_ROWS,
  }));

  useEffect(() => {
    const handleResize = () => {
      setSize({
        columns: stdout.columns || DEFAULT_COLUMNS,
        rows: stdout.rows || DEFAULT_ROWS,
      });
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}

// React context so deeply-nested components (the diff renderer inside a
// tool-call panel, the composer, the header) can read the live terminal
// size without threading a prop through every intermediate component —
// `useContext` reads the same live-updating value `useTerminalSize` above
// produces, re-rendering wherever it's consumed whenever a resize lands.
const TerminalSizeContext = createContext<{ columns: number; rows: number }>({
  columns: DEFAULT_COLUMNS,
  rows: DEFAULT_ROWS,
});

function useTerminalWidth(): number {
  return useContext(TerminalSizeContext).columns;
}

// ---------------------------------------------------------------------------
// OSC 8 file-path hyperlink — mirrors screen1's `toFileUrl`/`osc8Link` split
// (explicit ESC/BEL consts) rather than screen2's inline-control-character
// version, for source readability; behavior is identical to both. Falls
// back to plain text off a TTY, same as screen2's `hyperlinkPath`.
// ---------------------------------------------------------------------------

function toFileUrl(relativePath: string): string {
  const absolute = path.resolve(process.cwd(), relativePath);
  const encoded = absolute.split(path.sep).map(encodeURIComponent).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

function osc8Link(label: string, url: string): string {
  const ESC = '';
  const BEL = '';
  return `${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}`;
}

function hyperlinkPath(relativePath: string): string {
  if (!process.stdout.isTTY) return relativePath;
  return osc8Link(relativePath, toFileUrl(relativePath));
}

function FilePathLink({ relativePath }: { relativePath: string }) {
  return <Text color={TOKENS.accentInfo}>{hyperlinkPath(relativePath)}</Text>;
}

// ---------------------------------------------------------------------------
// Permission decision logic — ported verbatim (unchanged in substance) from
// `screen1-permission.tsx`, which itself ported it verbatim from
// `deus-v2-mvp/src/cli/tui-v2/deus-tui-permission-decision-v2.ts`
// (`permissionListKeyToResult`, oracle-tested: Enter checked first, hard
// clamp at both list ends). This is the behavior under evaluation across
// every screen in this prototype, not chrome — kept identical here too.
// ---------------------------------------------------------------------------

type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

interface PendingToolCall {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  preview: string;
  filePath?: string;
}

const PERMISSION_LIST_OPTIONS: ReadonlyArray<{
  decision: PermissionDecision;
  label: string;
}> = [
  { decision: 'allow_once', label: 'Allow once' },
  { decision: 'allow_always', label: 'Always allow' },
  { decision: 'deny', label: 'Deny' },
];

interface PermissionListKeypress {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
}

type PermissionSelectResult =
  | { type: 'move'; index: number }
  | { type: 'resolve'; decision: PermissionDecision }
  | { type: 'noop' };

function permissionListKeyToResult(
  currentIndex: number,
  key: PermissionListKeypress,
): PermissionSelectResult {
  if (key.return) {
    const option = PERMISSION_LIST_OPTIONS[currentIndex];
    if (!option) return { type: 'noop' };
    return { type: 'resolve', decision: option.decision };
  }
  if (key.downArrow) {
    const next = currentIndex + 1;
    if (next >= PERMISSION_LIST_OPTIONS.length) return { type: 'noop' };
    return { type: 'move', index: next };
  }
  if (key.upArrow) {
    const next = currentIndex - 1;
    if (next < 0) return { type: 'noop' };
    return { type: 'move', index: next };
  }
  return { type: 'noop' };
}

const DENY_TIMEOUT_MS = 15_000;
const TICK_MS = 250;
const SELECTED_MARK = '›';
const UNSELECTED_MARK = ' ';

/**
 * The inline permission panel. Structurally identical to
 * `screen1-permission.tsx`'s `PermissionPrompt` (same countdown-via-ref fix
 * from round 3's code review so the auto-deny genuinely fires), but rendered
 * here directly inside the live transcript flow by `<App>` rather than as a
 * standalone full-screen demo — this is the element the task calls out as
 * missing from prior rounds.
 */
function PermissionPrompt({
  call,
  onDecision,
}: {
  call: PendingToolCall;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const [cursorIndex, setCursorIndex] = useState(0);
  const [deadline] = useState(() => Date.now() + DENY_TIMEOUT_MS);
  const [remainingMs, setRemainingMs] = useState(DENY_TIMEOUT_MS);
  const onDecisionRef = useRef(onDecision);
  onDecisionRef.current = onDecision;

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        onDecisionRef.current('deny');
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  useInput((input: string, key: Key) => {
    if (!key.upArrow && !key.downArrow && !key.return) {
      const digit = Number(input);
      if (Number.isInteger(digit) && digit >= 1 && digit <= PERMISSION_LIST_OPTIONS.length) {
        const option = PERMISSION_LIST_OPTIONS[digit - 1];
        if (option) onDecision(option.decision);
        return;
      }
    }
    const result = permissionListKeyToResult(cursorIndex, {
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
    });
    if (result.type === 'move') setCursorIndex(result.index);
    else if (result.type === 'resolve') onDecision(result.decision);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TOKENS.semanticWarning} paddingX={1}>
      <Text bold color={TOKENS.semanticWarning}>
        Permission required
      </Text>
      <Box marginTop={1}>
        <Text color={TOKENS.textMuted}>⏺ </Text>
        <Text bold>{call.toolName}</Text>
      </Box>
      <Box>
        {call.filePath ? (
          <>
            <FilePathLink relativePath={call.filePath} />
            <Text color={TOKENS.textMuted}>{'  ('}{call.preview}{')'}</Text>
          </>
        ) : (
          <Text>{call.preview}</Text>
        )}
      </Box>
      <Text color={TOKENS.textMuted}>(auto-denies in {Math.ceil(remainingMs / 1000)}s)</Text>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_LIST_OPTIONS.map((option, index) => {
          const isSelected = index === cursorIndex;
          const isAlwaysAllow = option.decision === 'allow_always';
          const color = isSelected
            ? TOKENS.accentPrimary
            : isAlwaysAllow
              ? TOKENS.accentInfo
              : TOKENS.textMuted;
          const marker = isSelected ? SELECTED_MARK : UNSELECTED_MARK;
          return (
            <Text key={option.decision} color={color} bold={isSelected}>
              {marker} {index + 1}. {option.label}
            </Text>
          );
        })}
      </Box>
      <Text color={TOKENS.textMuted}>↑/↓ move · 1–3 choose · Enter confirm</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Diff / tool-result rendering — ported verbatim (in substance) from
// `screen2-tool-diff.tsx`: the "stateful bullet" convention (`toolCallState`,
// one `⏺` glyph family varying only by color), the line-numbered diff parser
// with context folding and truncation, and the `notApplied` false-positive-
// styling guard from round 3's code review (a denied/failed call's diff
// never inherits success green, even though it still carries a payload).
// ---------------------------------------------------------------------------

type ToolCallStatus = 'success' | 'error' | 'unknown';

type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; diffContent: string; filename?: string };

function toolCallState(status: ToolCallStatus): { glyph: string; color: string } {
  switch (status) {
    case 'success':
      return { glyph: '⏺', color: TOKENS.semanticSuccess };
    case 'error':
      return { glyph: '⏺', color: TOKENS.semanticError };
    case 'unknown':
      return { glyph: '⏺', color: TOKENS.textMuted };
    default: {
      const unhandled: never = status;
      void unhandled;
      return { glyph: '⏺', color: TOKENS.textMuted };
    }
  }
}

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

function truncate(lines: RenderLine[], maxLines: number): { shown: RenderLine[]; hiddenCount: number } {
  if (lines.length <= maxLines) return { shown: lines, hiddenCount: 0 };
  return { shown: lines.slice(0, maxLines), hiddenCount: lines.length - maxLines };
}

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 40;

// Chrome the diff line's content has to fit inside beyond raw terminal
// columns: the tool-result panel's own border (2 cols) + paddingX={1} on
// both sides (2 cols) in `ToolEntryView` below.
const DIFF_PANEL_CHROME_WIDTH = 4;

function renderDiffLine(
  line: RenderLine,
  key: number,
  gutterWidth: number,
  notApplied: boolean,
  maxContentWidth: number,
): React.ReactElement {
  if (line.type === 'folded') {
    return (
      <Text key={key} color={TOKENS.textMuted}>
        {' '.repeat(gutterWidth * 2 + 1)}⋯ {line.count} unchanged line{line.count === 1 ? '' : 's'} ⋯
      </Text>
    );
  }
  if (line.type === 'hunk') {
    return (
      <Text key={key} color={TOKENS.accentInfo}>
        {line.content}
      </Text>
    );
  }
  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const color = notApplied
    ? TOKENS.textMuted
    : line.type === 'add'
      ? TOKENS.semanticSuccess
      : line.type === 'del'
        ? TOKENS.semanticError
        : undefined;
  const oldNum = line.oldLine ? String(line.oldLine).padStart(gutterWidth) : ' '.repeat(gutterWidth);
  const newNum = line.newLine ? String(line.newLine).padStart(gutterWidth) : ' '.repeat(gutterWidth);
  // Live-width-aware truncation, not `wrap="wrap"`: a wrapped diff line
  // would break the fixed-width gutter/prefix alignment on the wrapped
  // continuation. `maxContentWidth` comes from `useTerminalWidth()` via
  // `DiffRenderer` below, so narrowing the real terminal genuinely
  // shortens what's shown here on the next resize-triggered render — this
  // is the concrete, verifiable effect of reading `useStdout()` reactively
  // (item 3), distinct from Ink's own automatic yoga re-stretch.
  const gutterChars = gutterWidth * 2 + 2;
  const available = Math.max(10, maxContentWidth - gutterChars - 1);
  const content =
    line.content.length > available ? `${line.content.slice(0, Math.max(0, available - 1))}…` : line.content;
  return (
    <Text key={key}>
      <Text color={TOKENS.textMuted}>
        {oldNum} {newNum}{' '}
      </Text>
      <Text color={color}>
        {prefix}
        {content}
      </Text>
    </Text>
  );
}

const DiffRenderer: React.FC<{ diffContent: string; filename?: string; notApplied: boolean }> = ({
  diffContent,
  filename,
  notApplied,
}) => {
  const terminalWidth = useTerminalWidth();
  const maxContentWidth = Math.max(20, terminalWidth - DIFF_PANEL_CHROME_WIDTH);

  const rawLines = parseDiff(diffContent);
  if (rawLines.length === 0) {
    return <Text color={TOKENS.textMuted}>No changes detected.</Text>;
  }

  const added = rawLines.filter((l) => l.type === 'add').length;
  const deleted = rawLines.filter((l) => l.type === 'del').length;
  const maxLineNo = rawLines.reduce((max, l) => Math.max(max, l.oldLine ?? 0, l.newLine ?? 0), 1);
  const gutterWidth = String(maxLineNo).length;

  const folded = foldContext(rawLines, CONTEXT_LINES);
  const { shown, hiddenCount } = truncate(folded, MAX_DIFF_LINES);

  return (
    <Box flexDirection="column">
      {filename && (
        <Box marginBottom={notApplied ? 0 : 1}>
          <Text>{hyperlinkPath(filename)}</Text>
          <Text color={notApplied ? TOKENS.textMuted : TOKENS.semanticSuccess}> +{added}</Text>
          <Text color={notApplied ? TOKENS.textMuted : TOKENS.semanticError}> -{deleted}</Text>
        </Box>
      )}
      {notApplied && (
        <Box marginBottom={1}>
          <Text bold color={TOKENS.semanticWarning}>
            Proposed changes — not applied
          </Text>
        </Box>
      )}
      {shown.map((line, i) => renderDiffLine(line, i, gutterWidth, notApplied, maxContentWidth))}
      {hiddenCount > 0 && <Text color={TOKENS.textMuted}>… {hiddenCount} more lines truncated …</Text>}
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
// Transcript entries — the live session state this shell renders. Distinct
// from screen2's static `fixtures` array: entries are appended and mutated
// over time by the scripted run below, which is what makes this a genuine
// playing-out session rather than a fixed composite.
// ---------------------------------------------------------------------------

type Entry =
  | { kind: 'user'; id: number; text: string }
  // `streaming` lives on the entry itself (flipped in the same `setEntries`
  // call as the text update), not in separate App-level state — see
  // `isEntrySettled`'s comment for why that matters for `<Static>`.
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: number;
      toolName: string;
      argsSummary: string;
      status: ToolCallStatus | 'pending';
      result?: ToolResultContent;
    };

function ToolEntryView({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  if (entry.status === 'pending') {
    return (
      <Box>
        <Text color={TOKENS.textMuted}>⏺ </Text>
        <Text bold>{entry.toolName}</Text>
        <Text>({entry.argsSummary})</Text>
      </Box>
    );
  }
  const state = toolCallState(entry.status);
  const borderColor = entry.status === 'error' ? TOKENS.semanticError : TOKENS.borderNeutral;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={state.color}>{state.glyph} </Text>
        <Text bold>{entry.toolName}</Text>
        <Text>({entry.argsSummary})</Text>
      </Box>
      {entry.result && (
        <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
          <ToolResultDisplay result={entry.result} status={entry.status} />
        </Box>
      )}
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Box>
          <Text color={TOKENS.textMuted}>{'> '}</Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return <Text wrap="wrap">{entry.text}</Text>;
    case 'tool':
      return <ToolEntryView entry={entry} />;
    default: {
      const unhandled: never = entry;
      void unhandled;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Settled vs. live — the split `<Static>` (item 1) needs. An entry is
// "settled" once it can never mutate again: a user entry is complete the
// moment it's created; a tool entry stops mutating once its status leaves
// `'pending'`; an assistant entry stops mutating once its own `streaming`
// field flips to `false`.
//
// Correctness note (found via a first-hand render-log instrumentation
// test, not assumed — see round-5 verification notes): this MUST read a
// field on the entry itself, not a separate piece of App-level state like
// a `streamingEntryId` tracked alongside `entries`. An early version used
// exactly that separate-state shape, and `stream()`'s
// `setEntries(...)` + `setStreamingEntryId(id)` calls are two distinct
// `setState`s — React can commit a render in between them, where the new
// assistant entry already exists in `entries` (with empty text) but
// `streamingEntryId` hasn't been updated to its id yet, so it reads as
// "settled" for exactly one frame. `<Static>` has no way to un-print
// something once it's graduated an item, so that one bad frame
// permanently baked an empty assistant line into real terminal
// scrollback, ahead of the correct, fully-streamed line arriving later —
// a real, reproducible double-print. Deriving settledness from a field on
// the entry itself, updated in the exact same `setEntries` call as the
// content, closes the gap: there is no state to fall out of sync.
// ---------------------------------------------------------------------------

function isEntrySettled(entry: Entry): boolean {
  switch (entry.kind) {
    case 'user':
      return true;
    case 'tool':
      return entry.status !== 'pending';
    case 'assistant':
      return !entry.streaming;
    default: {
      const unhandled: never = entry;
      void unhandled;
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Spinner — spec's "Spinner and active status": an animated frame paired
// with a rotating gerund, not "Loading…". Word list is the spec's confirmed
// examples verbatim. Shown only while genuinely working with nothing else
// live on screen (no streamed text yet, no permission panel open) — per the
// spec's rule that a spinner during a human-approval pause would falsely
// imply continued progress.
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_WORDS = [
  'Pondering',
  'Percolating',
  'Cogitating',
  'Ruminating',
  'Deliberating',
  'Musing',
  'Inferring',
  'Deciphering',
];

function Spinner() {
  const [frame, setFrame] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * SPINNER_WORDS.length));
  useEffect(() => {
    const frameTimer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    const wordTimer = setInterval(() => setWordIndex((i) => (i + 1) % SPINNER_WORDS.length), 950);
    return () => {
      clearInterval(frameTimer);
      clearInterval(wordTimer);
    };
  }, []);
  return (
    <Text color={TOKENS.accentPrimary}>
      {SPINNER_FRAMES[frame]} {SPINNER_WORDS[wordIndex]}…
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Shell chrome — header/status bar, footer Tasks pill, composer.
// ---------------------------------------------------------------------------

/**
 * The `{columns}×{rows}` readout is the concrete, verifiable proof of item
 * 3: it's a live number, read straight from `useTerminalWidth()`/
 * `TerminalSizeContext` (backed by `useStdout()`'s `'resize'` event), not a
 * static label — resizing the real terminal pane changes this number on
 * screen without restarting the process. `justifyContent="space-between"`
 * already stretches this row to the full terminal width implicitly (Ink's
 * root yoga node is resized to `terminalWidth` on every resize — confirmed
 * by reading `node_modules/ink/build/ink.js`'s `calculateLayout`/`resized`
 * — and column-flex children default to stretching to their parent's
 * width), which is *also* genuinely reactive, just not visibly numeric on
 * its own; the readout makes that implicit reflow legible.
 */
function Header({ status }: { status: 'idle' | 'working' }) {
  const { columns, rows } = useContext(TerminalSizeContext);
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold>Deus</Text>
        <Text color={TOKENS.textMuted}> · deus-v2-mvp/full-shell-demo · {columns}×{rows}</Text>
      </Text>
      <Text color={status === 'working' ? TOKENS.accentPrimary : TOKENS.textMuted}>
        {status === 'working' ? '● working' : '● idle'}
      </Text>
    </Box>
  );
}

/**
 * Spec's "Current Tasks footer": pills, not the obsolete inline checkbox
 * list. Kept deliberately minimal per the task's own instruction — this
 * demo's "tasks" are literally this fixture conversation's own three real
 * steps (read → fix → test), tracked as a plain `Tasks n/total` count. No
 * per-task names, no fabricated dependency/blocked-state pills are added;
 * the spec's own note against decorating the permission/diff prototypes
 * with a Tasks pill they don't model applies in spirit here too — this
 * shell only shows the pill because it genuinely has real, sequential work
 * to count.
 */
function Footer({ tasksDone, tasksTotal }: { tasksDone: number; tasksTotal: number }) {
  if (tasksTotal === 0) {
    return (
      <Box marginTop={1}>
        <Text color={TOKENS.textMuted}>? for shortcuts</Text>
      </Box>
    );
  }
  const allDone = tasksDone === tasksTotal;
  const pillColor = allDone ? TOKENS.semanticSuccess : TOKENS.accentPrimary;
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box borderStyle="round" borderColor={pillColor} paddingX={1}>
        <Text color={pillColor}>
          Tasks {tasksDone}/{tasksTotal}
        </Text>
      </Box>
      <Text color={TOKENS.textMuted}>? for shortcuts</Text>
    </Box>
  );
}

const CURSOR_BLINK_MS = 530;

interface ComposerProps {
  /** Whether the composer should accept input at all right now. */
  active: boolean;
  /**
   * Fixture text to auto-type (unattended-capture fallback) if no real
   * keystroke lands within `autoFillDelayMs` of becoming active.
   */
  autoFillText?: string;
  autoFillDelayMs: number;
  onSubmit: (text: string) => void;
}

/**
 * A genuinely real, raw-mode `useInput`-driven composer (item 2) — the same
 * shape as `PermissionPrompt` above: `text` is internal component state
 * mutated *only* inside the `useInput` handler (character append,
 * backspace/delete, Enter-to-submit), never overwritten by a parent-passed
 * string prop. There is exactly one code path that changes `text`; whether
 * a given character arrives from a real key or the auto-fill fallback
 * below, it goes through the same `setText` call.
 *
 * Verified for real, not just claimed:
 *   - `npx tsx src/full-shell.tsx` inside a tmux pane, with
 *     `COMPOSER_AUTOFILL_DELAY_MS=30000` (so the unattended fallback can't
 *     fire first) — then `tmux send-keys` sent literal characters `hello`
 *     one at a time and a real `BSpace` keypress, and `tmux capture-pane`
 *     showed `hell` → `hello` → `hell` character by character, i.e. genuine
 *     backspace-capable live typing, not a scripted string. See the
 *     round-5 verification notes in the session log / FINDINGS.md for the
 *     captured pane transcript.
 *   - With the default short delay (unattended recording path), the
 *     fallback timer advances the identical `text` state on the identical
 *     cadence the old prop-driven typewriter used, so the recorded fixture
 *     plays out unchanged end to end when nobody is at the keyboard.
 */
function Composer({ active, autoFillText, autoFillDelayMs, onSubmit }: ComposerProps) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [blink, setBlink] = useState(true);
  const realKeyReceivedRef = useRef(false);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    const t = setInterval(() => setBlink((b) => !b), CURSOR_BLINK_MS);
    return () => clearInterval(t);
  }, []);

  const isListening = active && !submitted;

  useInput(
    (input, key) => {
      // Ignore bare modifier/navigation combos — they're not text input,
      // and must NOT count as "a real key landed": some pty/harness setups
      // (confirmed via a `script(1)`-captured raw-byte test — see the
      // round-5 verification notes) deliver an initial stray control
      // sequence before any genuine keystroke, and marking
      // `realKeyReceivedRef` on *any* input, even ignored ones, would
      // permanently disable the unattended auto-fill fallback below.
      if (key.ctrl || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        return;
      }
      if (key.return) {
        const value = textRef.current.trim();
        if (value.length === 0) return;
        realKeyReceivedRef.current = true;
        setSubmitted(true);
        onSubmitRef.current(value);
        return;
      }
      if (key.backspace || key.delete) {
        realKeyReceivedRef.current = true;
        setText((t) => t.slice(0, -1));
        return;
      }
      if (key.escape) {
        realKeyReceivedRef.current = true;
        setText('');
        return;
      }
      if (input) {
        realKeyReceivedRef.current = true;
        setText((t) => t + input);
      }
    },
    { isActive: isListening },
  );

  // Unattended-capture fallback — structurally identical to
  // `PermissionPrompt`'s auto-deny countdown above: a real interaction
  // (`realKeyReceivedRef`) always wins if it happens first, and the
  // fallback is what makes the fixture recording work with nobody at the
  // keyboard.
  useEffect(() => {
    if (!isListening || !autoFillText) return undefined;
    const armTimer = setTimeout(() => {
      if (realKeyReceivedRef.current) return;
      let i = 0;
      const typeTimer = setInterval(() => {
        i += 1;
        setText(autoFillText.slice(0, i));
        if (i >= autoFillText.length) {
          clearInterval(typeTimer);
          setTimeout(() => {
            if (realKeyReceivedRef.current) return;
            setSubmitted(true);
            onSubmitRef.current(autoFillText);
          }, 350);
        }
      }, 12);
    }, autoFillDelayMs);
    return () => clearTimeout(armTimer);
  }, [isListening, autoFillText, autoFillDelayMs]);

  const showCursor = isListening;
  const borderColor = text ? TOKENS.accentPrimary : TOKENS.borderNeutral;
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={TOKENS.textMuted}>{'> '}</Text>
      {text ? (
        <Text>{text}</Text>
      ) : !showCursor ? (
        <Text color={TOKENS.textMuted}>Try &quot;help&quot; for more information</Text>
      ) : null}
      {showCursor && <Text color={TOKENS.accentPrimary}>{blink ? '▌' : ' '}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The fixture conversation. Not a step-array interpreter — a plain async
// function calling small helpers the <App> below wires to real React state,
// so the flow can genuinely branch on what happens at the permission
// interrupt (approved vs. denied) rather than always taking one hardcoded
// path.
// ---------------------------------------------------------------------------

const DATE_FIX_DIFF = `--- a/src/utils/date-formatter.ts
+++ b/src/utils/date-formatter.ts
@@ -12,6 +12,6 @@
 export function formatDate(input: Date): string {
   const year = input.getFullYear();
   const month = input.getMonth() + 1;
-  const day = input.getDate() - 1;
+  const day = input.getDate();
   return year + '-' + pad(month) + '-' + pad(day);
 }`;

// The fixture's opening line — now delivered as the real composer's
// auto-fill fallback content (see `Composer`) rather than driving
// `composerText` directly, so it's only ever *typed* text, never a
// separately-injected prop.
const FIXTURE_USER_MESSAGE = "Can you fix the off-by-one bug in the date formatter and check the tests still pass?";

// Overridable purely for the manual real-keystroke verification pass (see
// `Composer`'s doc comment) — gives a human enough time to type before the
// unattended-recording fallback would otherwise kick in. Unset in normal
// runs, where the short default keeps the recorded fixture's original
// timing.
const COMPOSER_AUTOFILL_DELAY_MS = Number(process.env['COMPOSER_AUTOFILL_DELAY_MS']) || 500;

interface ScriptCtx {
  think: (ms: number) => Promise<void>;
  stream: (text: string) => Promise<void>;
  startTool: (toolName: string, argsSummary: string) => number;
  resolveTool: (id: number, status: ToolCallStatus, result?: ToolResultContent) => void;
  askPermission: (call: PendingToolCall) => Promise<PermissionDecision>;
  setTasksState: (done: number, total: number) => void;
}

/**
 * Runs after the opening user message has already been submitted (via the
 * real composer) and pushed into the transcript by `<App>` — this no longer
 * includes the `addUser` step itself.
 */
async function runScript(ctx: ScriptCtx): Promise<void> {
  const { think, stream, startTool, resolveTool, askPermission, setTasksState } = ctx;

  await think(1600);
  await stream("I'll take a look at the date formatter first.");

  const readId = startTool('Read', 'src/utils/date-formatter.ts');
  await think(700);
  resolveTool(readId, 'success', {
    type: 'text',
    text: "Found it — getDate() - 1 rolls into the previous month near the 1st. Should just be getDate().",
  });

  await think(500);
  await stream('Now I need your approval to apply the fix.');

  const editId = startTool('Edit', 'src/utils/date-formatter.ts');
  const decision = await askPermission({
    approvalId: 'appr_1',
    toolCallId: `call_${editId}`,
    toolName: 'Edit',
    filePath: 'src/utils/date-formatter.ts',
    preview: '1 line changed',
  });

  if (decision === 'deny') {
    resolveTool(editId, 'error', { type: 'text', text: 'Permission denied by user.' });
    setTasksState(1, 3);
    await stream("Understood — I won't make that change. Let me know if you'd like a different approach.");
    setTasksState(3, 3);
    return;
  }

  await think(500);
  resolveTool(editId, 'success', {
    type: 'diff',
    filename: 'src/utils/date-formatter.ts',
    diffContent: DATE_FIX_DIFF,
  });
  setTasksState(1, 3);

  await stream('Fix applied. Running the test suite now.');

  const testId = startTool('Bash', 'npm test');
  await think(1400);
  resolveTool(testId, 'success', { type: 'text', text: '42 passed, 0 failed (1.8s)' });
  setTasksState(2, 3);

  await stream(
    "All done — formatDate no longer rolls into the previous month, and the full suite passes (42/42).",
  );
  setTasksState(3, 3);
}

// ---------------------------------------------------------------------------
// App — wires the fixture script above to real React state and renders the
// shell. Every visible transition (typing, spinner, streaming, the
// permission interrupt, the diff, the footer pill) is driven by an actual
// state update, not a pre-baked static frame.
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp();
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const terminalSize = useTerminalSize();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'idle' | 'working'>('idle');
  const [firstMessageSubmitted, setFirstMessageSubmitted] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingToolCall | null>(null);
  const [tasksDone, setTasksDone] = useState(0);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [sessionDone, setSessionDone] = useState(false);
  const resolvePermissionRef = useRef<((d: PermissionDecision) => void) | null>(null);
  // Set inside the mount effect below; called by the real composer's
  // `onSubmit` once the opening message (real-typed or auto-filled) lands.
  const beginRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    async function think(ms: number) {
      if (cancelled) return;
      setStatus('working');
      await sleep(ms);
    }

    async function stream(text: string) {
      if (cancelled) return;
      const id = nextId();
      // `streaming: true` is set in the exact same `setEntries` call that
      // creates the entry, and flipped to `false` in the exact same call
      // that writes its final text below — never a separate `setState`.
      // See `isEntrySettled`'s comment for the double-print bug this
      // avoids.
      setEntries((e) => [...e, { kind: 'assistant', id, text: '', streaming: true }]);
      for (let i = 0; i < text.length; i += 3) {
        if (cancelled) return;
        const chunk = text.slice(0, i + 3);
        setEntries((e) => e.map((en) => (en.kind === 'assistant' && en.id === id ? { ...en, text: chunk } : en)));
        await sleep(18);
      }
      if (cancelled) return;
      setEntries((e) =>
        e.map((en) => (en.kind === 'assistant' && en.id === id ? { ...en, text, streaming: false } : en)),
      );
      await sleep(150);
    }

    function startTool(toolName: string, argsSummary: string): number {
      const id = nextId();
      setEntries((e) => [...e, { kind: 'tool', id, toolName, argsSummary, status: 'pending' }]);
      return id;
    }

    function resolveTool(id: number, resultStatus: ToolCallStatus, result?: ToolResultContent) {
      setEntries((e) =>
        e.map((en) => (en.kind === 'tool' && en.id === id ? { ...en, status: resultStatus, result } : en)),
      );
    }

    async function askPermission(call: PendingToolCall): Promise<PermissionDecision> {
      setStatus('working');
      const decision = await new Promise<PermissionDecision>((resolve) => {
        resolvePermissionRef.current = resolve;
        setPendingPermission(call);
      });
      setPendingPermission(null);
      resolvePermissionRef.current = null;
      return decision;
    }

    function setTasksState(done: number, total: number) {
      setTasksDone(done);
      setTasksTotal(total);
    }

    // The opening message now arrives from the real composer (item 2)
    // instead of this effect driving it directly — `beginRef.current` is
    // what the composer's `onSubmit` calls once it has real (or
    // auto-filled-fallback) text, and only then does the rest of the
    // scripted flow start.
    beginRef.current = (text: string) => {
      const id = nextId();
      setEntries((e) => [...e, { kind: 'user', id, text }]);
      setTasksState(0, 3);
      void (async () => {
        await runScript({ think, stream, startTool, resolveTool, askPermission, setTasksState });
        if (cancelled) return;
        setStatus('idle');
        setSessionDone(true);
        await sleep(2500);
        if (!cancelled) exit();
      })();
    };

    return () => {
      cancelled = true;
    };
  }, [exit]);

  // Safety fallback so a stalled Ink render loop (e.g. no TTY driving the
  // recorder) can't hang the process forever — mirrors screen2's
  // setTimeout(process.exit) backstop.
  useEffect(() => {
    if (!sessionDone) return undefined;
    const t = setTimeout(() => process.exit(0), 4000);
    return () => clearTimeout(t);
  }, [sessionDone]);

  // Derived straight from `entries` (not separate state) for the same
  // reason `isEntrySettled` reads `entry.streaming` — one source of truth,
  // no cross-state race.
  const isStreaming = entries.some((entry) => entry.kind === 'assistant' && entry.streaming);
  const showSpinner = status === 'working' && !isStreaming && !pendingPermission;

  // Item 1: split into what's permanently settled (→ `<Static>`, written
  // once to real scrollback) vs. what's still changing (→ the live tree
  // below it, re-rendered every frame).
  const historyEntries = entries.filter((entry) => isEntrySettled(entry));
  const liveEntries = entries.filter((entry) => !isEntrySettled(entry));

  const handleComposerSubmit = (text: string) => {
    setFirstMessageSubmitted(true);
    beginRef.current?.(text);
  };

  return (
    <TerminalSizeContext.Provider value={terminalSize}>
      <Box flexDirection="column">
        <Static items={historyEntries}>
          {(entry) => (
            <Box key={entry.id} marginBottom={1}>
              <EntryView entry={entry} />
            </Box>
          )}
        </Static>
        <Box flexDirection="column">
          <Header status={status} />
          <Box flexDirection="column" marginY={1}>
            {liveEntries.map((entry) => (
              <Box key={entry.id} marginBottom={1}>
                <EntryView entry={entry} />
              </Box>
            ))}
            {showSpinner && <Spinner />}
            {pendingPermission && (
              <PermissionPrompt
                call={pendingPermission}
                onDecision={(d) => resolvePermissionRef.current?.(d)}
              />
            )}
          </Box>
          <Footer tasksDone={tasksDone} tasksTotal={tasksTotal} />
          <Composer
            active={!firstMessageSubmitted}
            autoFillText={FIXTURE_USER_MESSAGE}
            autoFillDelayMs={COMPOSER_AUTOFILL_DELAY_MS}
            onSubmit={handleComposerSubmit}
          />
        </Box>
      </Box>
    </TerminalSizeContext.Provider>
  );
}

render(<App />);
