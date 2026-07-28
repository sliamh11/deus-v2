#!/usr/bin/env node
/**
 * LIA-494 prototype — round 4: the FULL Claude Code app-shell mimicry.
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
 * What's scripted vs. what's real: the *conversation* (user message, tool
 * calls, diff, permission request, test results) is a fixture — there is no
 * live model or daemon behind it, exactly like screens 1 and 2. But the
 * *rendering* is genuinely live: assistant text is streamed chunk by chunk
 * through real React state updates (not printed as a static block), the
 * spinner and its gerund word actually rotate on independent timers, and
 * the permission prompt is a real `useInput`-driven Ink component — a
 * person can press 1/2/3 or arrows+Enter to resolve it, or let its
 * unattended 15s auto-deny countdown resolve it (mirroring round 3's
 * `screen1-autodeny-fix` proof that the countdown genuinely fires), and the
 * script continues into a real, different branch (denied vs. approved)
 * depending on what actually happened.
 */
import path from 'node:path';
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp, type Key } from 'ink';

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

function renderDiffLine(
  line: RenderLine,
  key: number,
  gutterWidth: number,
  notApplied: boolean,
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
  return (
    <Text key={key}>
      <Text color={TOKENS.textMuted}>
        {oldNum} {newNum}{' '}
      </Text>
      <Text color={color}>
        {prefix}
        {line.content}
      </Text>
    </Text>
  );
}

const DiffRenderer: React.FC<{ diffContent: string; filename?: string; notApplied: boolean }> = ({
  diffContent,
  filename,
  notApplied,
}) => {
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
      {shown.map((line, i) => renderDiffLine(line, i, gutterWidth, notApplied))}
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
  | { kind: 'assistant'; id: number; text: string }
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

function Header({ status }: { status: 'idle' | 'working' }) {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold>Deus</Text>
        <Text color={TOKENS.textMuted}> · deus-v2-mvp/full-shell-demo</Text>
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

function Composer({ text, typing, disabled }: { text: string; typing: boolean; disabled: boolean }) {
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(t);
  }, []);
  const showCursor = typing || !disabled;
  const borderColor = typing ? TOKENS.accentPrimary : TOKENS.borderNeutral;
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={TOKENS.textMuted}>{'> '}</Text>
      {text ? (
        <Text>{text}</Text>
      ) : !typing ? (
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

interface ScriptCtx {
  addUser: (text: string) => Promise<void>;
  think: (ms: number) => Promise<void>;
  stream: (text: string) => Promise<void>;
  startTool: (toolName: string, argsSummary: string) => number;
  resolveTool: (id: number, status: ToolCallStatus, result?: ToolResultContent) => void;
  askPermission: (call: PendingToolCall) => Promise<PermissionDecision>;
  setTasksState: (done: number, total: number) => void;
}

async function runScript(ctx: ScriptCtx): Promise<void> {
  const { addUser, think, stream, startTool, resolveTool, askPermission, setTasksState } = ctx;

  setTasksState(0, 3);

  await addUser("Can you fix the off-by-one bug in the date formatter and check the tests still pass?");

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

  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<'idle' | 'working'>('idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [composerTyping, setComposerTyping] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingToolCall | null>(null);
  const [tasksDone, setTasksDone] = useState(0);
  const [tasksTotal, setTasksTotal] = useState(0);
  const [sessionDone, setSessionDone] = useState(false);
  const resolvePermissionRef = useRef<((d: PermissionDecision) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    async function addUser(text: string) {
      setStatus('working');
      setComposerTyping(true);
      for (let i = 0; i < text.length; i += 2) {
        if (cancelled) return;
        setComposerText(text.slice(0, i + 2));
        await sleep(12);
      }
      if (cancelled) return;
      setComposerText(text);
      await sleep(350);
      if (cancelled) return;
      setComposerTyping(false);
      setComposerText('');
      const id = nextId();
      setEntries((e) => [...e, { kind: 'user', id, text }]);
      await sleep(200);
    }

    async function think(ms: number) {
      if (cancelled) return;
      setStatus('working');
      await sleep(ms);
    }

    async function stream(text: string) {
      if (cancelled) return;
      const id = nextId();
      setEntries((e) => [...e, { kind: 'assistant', id, text: '' }]);
      setIsStreaming(true);
      for (let i = 0; i < text.length; i += 3) {
        if (cancelled) return;
        const chunk = text.slice(0, i + 3);
        setEntries((e) => e.map((en) => (en.kind === 'assistant' && en.id === id ? { ...en, text: chunk } : en)));
        await sleep(18);
      }
      if (cancelled) return;
      setEntries((e) => e.map((en) => (en.kind === 'assistant' && en.id === id ? { ...en, text } : en)));
      setIsStreaming(false);
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

    async function run() {
      await runScript({ addUser, think, stream, startTool, resolveTool, askPermission, setTasksState });
      if (cancelled) return;
      setStatus('idle');
      setSessionDone(true);
      await sleep(2500);
      if (!cancelled) exit();
    }

    run();
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

  const showSpinner = status === 'working' && !isStreaming && !pendingPermission;

  return (
    <Box flexDirection="column">
      <Header status={status} />
      <Box flexDirection="column" marginY={1}>
        {entries.map((entry) => (
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
      <Composer text={composerText} typing={composerTyping} disabled={status === 'working' && !composerTyping} />
    </Box>
  );
}

render(<App />);
