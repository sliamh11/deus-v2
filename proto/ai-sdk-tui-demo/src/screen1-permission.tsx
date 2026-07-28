#!/usr/bin/env node
/**
 * LIA-494 prototype -- screen 1: the three-way permission-prompt flow.
 *
 * Round 3 (design comparison): restyled onto the Claude Code design
 * language spec (see the reconcile stage's `spec-and-plan.md`, "Claude
 * Code Design Language Spec" + "@ai-sdk/tui" application plan). This pass
 * changes VISUAL PRESENTATION ONLY -- the ported decision logic below is
 * untouched from round 1/2, per the spec's explicit instruction to
 * "preserve `permissionListKeyToResult`, the hard-clamped cursor behavior,
 * `toLibraryResponse`, and the consumer-owned `alwaysAllowed` state" since
 * those are the behavior under evaluation, not the chrome around them.
 *
 * Replicates Deus's real `PermissionModal.tsx` decision semantics
 * (`allow_once` / `allow_always` / `deny`), not a two-way y/n stand-in.
 * Ported verbatim (logic, not styling) from the real production files:
 *   - deus-v2-mvp/src/cli/tui-v2/components/PermissionModal.tsx
 *   - deus-v2-mvp/src/cli/tui-v2/deus-tui-permission-decision-v2.ts
 *     (`PERMISSION_LIST_OPTIONS`, `permissionListKeyToResult` -- the
 *     oracle-tested pure function: Enter checked first so a stray
 *     simultaneous arrow flag never overrides an explicit confirm;
 *     Up/Down hard-clamp at the list bounds, i.e. clamped moves are a
 *     no-op, never a same-index "move".)
 *
 * SETUP-STAGE FINDING THIS SCREEN EXISTS TO DEMONSTRATE (confirmed by
 * reading node_modules/@ai-sdk/tui/src/agent-tui-runner.ts:65-68 and
 * node_modules/@ai-sdk/tui/src/tui/terminal-renderer.ts:327-382): the
 * library's own tool-approval primitive is STRICTLY BINARY --
 * `AgentTUIToolApprovalResponse = { approved: boolean; reason?: string }`,
 * with a default renderer that only recognizes 'y'/'n' keystrokes and no
 * persistent-grant concept anywhere. This screen builds the 3-way UI *and*
 * the "remember this tool" behavior entirely as consumer-side state (the
 * `alwaysAllowed` Set below) and only maps DOWN onto the library's binary
 * shape at the boundary (`toLibraryResponse`) -- it does not subclass or
 * reuse the library's internal (non-exported) TerminalRenderer, and does not
 * drive runAgentTUI's live agent loop, since no live LLM loop is needed to
 * demonstrate the interaction contract itself. Fully custom Ink screen, per
 * the setup stage's own recommendation for exactly this situation.
 *
 * IMPORTANT -- every Claude Code visual convention below (color tokens,
 * `⏺` glyphs, rounded panel, OSC 8 file-path hyperlink, numbered options)
 * is consumer-owned Ink code written for this prototype. `@ai-sdk/tui`
 * supplies none of it -- its only contribution to this screen remains the
 * confirmed binary-approval finding above. Do not credit the library for
 * this styling; see FINDINGS.md.
 *
 * NAMING COLLISION NOTE: nothing in this file is Deus's own `ChatTransport`
 * (`deus-v2-mvp/src/cli/deus-native-chat-client.ts:125`, a `turn()`/
 * `respondPermission()`/`setPlanMode()` interface) -- that's an unrelated,
 * same-named concept belonging to Deus's real IPC layer. This file has no
 * transport at all; it is pure UI driven by an in-memory demo queue.
 */
import path from 'node:path';
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp, type Key } from 'ink';

// ---------------------------------------------------------------------------
// Claude Code design-language tokens (spec-and-plan.md "Color system").
// Hex values only, per the spec's implementation rule to express every
// prototype color through named tokens rather than Ink's built-in color
// names ("red", "yellow", "cyan", ...). Only the tokens this screen actually
// uses are included -- no decorative unused entries.
// ---------------------------------------------------------------------------

const TOKENS = {
  textMuted: '#B0AEA5',
  accentPrimary: '#D97757',
  accentInfo: '#6A9BCC',
  semanticSuccess: '#788C5D',
  semanticWarning: '#C49A52',
  semanticError: '#B95C50',
} as const;

// ---------------------------------------------------------------------------
// Types ported from real production code (not invented for this demo).
// ---------------------------------------------------------------------------

/** Deus's real 3-way decision -- agent-runtimes/types.ts PermissionDecision. */
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/** @ai-sdk/tui's actual wire primitive (agent-tui-runner.ts:65-68). Binary --
 *  this screen's 3-way PermissionDecision is mapped DOWN onto this shape,
 *  never the other way around. */
interface AgentTUIToolApprovalResponse {
  approved: boolean;
  reason?: string;
}

/** Subset of the library's real AgentTUIToolApprovalRequest fields used here. */
interface PendingToolCall {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  /** Concise, human-readable summary of the call's arguments -- never raw
   *  JSON, per the spec's "avoid displaying raw JSON as the primary
   *  presentation" rule. */
  preview: string;
  /** Present only when the call targets a specific file; rendered via the
   *  OSC 8 hyperlink component below rather than as plain text. */
  filePath?: string;
}

/** Fixed cursor order, verbatim from deus-tui-permission-decision-v2.ts. */
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

/**
 * Ported verbatim (logic only, unchanged since round 1) from the real,
 * independently oracle-tested `permissionListKeyToResult` in
 * deus-tui-permission-decision-v2.ts. Boundary policy is the oracle's
 * pinned choice: HARD-CLAMP at both ends -- Up at index 0 / Down at the
 * last index is a no-op, not a move. The design pass adds direct `1`/`2`/`3`
 * selection (spec: "Accept direct 1, 2, and 3 selection as well as arrows
 * plus Enter") as an ADDITIONAL input path in `PermissionPrompt`'s
 * `useInput` below, deliberately outside this function, so the ported
 * pure function itself stays byte-for-byte the behavior under evaluation.
 */
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

/**
 * Maps the 3-way decision onto @ai-sdk/tui's binary wire primitive. This is
 * the consumer-side responsibility the setup stage's finding called out --
 * the library has no `allow_always` concept, so persistence lives entirely
 * above this boundary (see the `alwaysAllowed` Set in <App> below, which is
 * explicitly demo-local: a real deployment's persistent grant belongs to the
 * daemon/warden permission authority, not React state), and only a plain
 * `approved: boolean` ever crosses it.
 */
function toLibraryResponse(
  decision: PermissionDecision,
): AgentTUIToolApprovalResponse {
  if (decision === 'deny') return { approved: false, reason: 'Denied by user.' };
  return { approved: true };
}

// ---------------------------------------------------------------------------
// OSC 8 file-path hyperlink -- spec's "Tool-call typography and glyphs" /
// "For file paths" rules: resolve relative to cwd, emit a percent-encoded
// `file://` target, show the concise relative path as the visible label,
// and apply color independently of hyperlink correctness (a terminal that
// ignores OSC 8 still renders the plain colored label, which is the
// documented fallback -- there is no reliable synchronous way to probe OSC 8
// support, so the safe default is to always emit the sequence).
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

function FilePathLink({ relativePath }: { relativePath: string }) {
  return (
    <Text color={TOKENS.accentInfo}>{osc8Link(relativePath, toFileUrl(relativePath))}</Text>
  );
}

// ---------------------------------------------------------------------------
// Demo queue -- "Bash" deliberately repeats so the allow_always persistence
// (auto-resolve with NO prompt the 2nd time) is visible in the capture.
// ---------------------------------------------------------------------------

const QUEUE: PendingToolCall[] = [
  { approvalId: 'appr_1', toolCallId: 'call_1', toolName: 'Bash', preview: 'npm test' },
  {
    approvalId: 'appr_2',
    toolCallId: 'call_2',
    toolName: 'WriteFile',
    filePath: 'src/index.ts',
    preview: '42 lines',
  },
  { approvalId: 'appr_3', toolCallId: 'call_3', toolName: 'Bash', preview: 'git status' },
  {
    approvalId: 'appr_4',
    toolCallId: 'call_4',
    toolName: 'WebFetch',
    preview: 'https://example.com/pricing',
  },
];

interface DecisionLogEntry {
  toolName: string;
  preview: string;
  wire: AgentTUIToolApprovalResponse;
  /** Persistent-scope annotation for `allow_always` outcomes, rendered in
   *  `accent.info` per the spec's "use accent.info for the persistent scope
   *  in Always allow" rule. Absent for allow_once/deny. */
  scopeNote?: string;
}

const DENY_TIMEOUT_MS = 15_000;
const TICK_MS = 250;
/** Selected-row marker. Spec: replace the old `●` chooser mark with `›`. */
const SELECTED_MARK = '›';
const UNSELECTED_MARK = ' ';

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
  // ROUND-3 FIX (codex review finding #2): the countdown previously only
  // updated the displayed number and never actually resolved the prompt at
  // 0 -- "auto-denies in 0s" sat there indefinitely. `onDecision` is read
  // through a ref (updated every render) rather than added to the effect's
  // dependency array, so the interval is created exactly once per prompt
  // (keyed by `deadline`, which is itself set once via useState's lazy
  // initializer) instead of resetting the timer on every parent re-render.
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
    // Direct 1/2/3 selection (spec addition, round 3) -- deliberately kept
    // outside the ported `permissionListKeyToResult` pure function so that
    // function stays exactly the oracle-tested behavior under evaluation.
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
      {/* Auto-deny countdown: Deus-specific safety behavior, not a confirmed
          Claude Code visual detail (spec: "reasoned extension ... Deus-
          specific"). */}
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

function DecisionLine({ entry }: { entry: DecisionLogEntry }) {
  // Stateful `⏺` convention (spec "Tool-call typography and glyphs"):
  // one glyph family throughout, gray while unresolved -> green on approval
  // -> red on denial/failure. Never switches to a different glyph family
  // (no more ✓/✗/? here). Raw wire diagnostics ("[wire: approved=...]") are
  // intentionally NOT rendered -- spec: "Remove [wire: approved=…]
  // diagnostics from the visual capture."
  const glyphColor = entry.wire.approved ? TOKENS.semanticSuccess : TOKENS.semanticError;
  return (
    <Text>
      <Text color={glyphColor}>⏺</Text> <Text bold>{entry.toolName}</Text>{' '}
      <Text color={TOKENS.textMuted}>{entry.preview}</Text>
      {entry.scopeNote ? <Text color={TOKENS.accentInfo}> {entry.scopeNote}</Text> : null}
    </Text>
  );
}

function App() {
  const { exit } = useApp();
  const [queueIndex, setQueueIndex] = useState(0);
  // Explicitly demo-local: a real deployment's persistent "always allow"
  // grant belongs to the daemon/warden permission authority, never plain
  // React state (spec: "Keep alwaysAllowed explicitly demo-local").
  const [alwaysAllowed, setAlwaysAllowed] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<DecisionLogEntry[]>([]);
  const [done, setDone] = useState(false);

  const current = QUEUE[queueIndex];

  // Auto-resolve WITHOUT prompting when the tool is already in the
  // always-allow set -- the consumer-side persistence the library itself has
  // no concept of (see toLibraryResponse's doc comment above).
  useEffect(() => {
    if (!current) {
      setDone(true);
      return;
    }
    if (alwaysAllowed.has(current.toolName)) {
      const wire = toLibraryResponse('allow_always');
      setLog((l) => [
        ...l,
        {
          toolName: current.toolName,
          preview: current.preview,
          wire,
          scopeNote: '(always allow · auto)',
        },
      ]);
      setQueueIndex((i) => i + 1);
    }
    // current/alwaysAllowed are derived from queueIndex/alwaysAllowed already
    // in the dependency list; re-running on either change is exactly the
    // desired trigger for "queue advanced" or "a new always-allow grant".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIndex, alwaysAllowed]);

  useEffect(() => {
    if (done) {
      const timer = setTimeout(() => exit(), 1500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [done, exit]);

  function handleDecision(decision: PermissionDecision) {
    if (!current) return;
    if (decision === 'allow_always') {
      setAlwaysAllowed((s) => new Set(s).add(current.toolName));
    }
    const wire = toLibraryResponse(decision);
    const scopeNote = decision === 'allow_always' ? '(always allow)' : undefined;
    setLog((l) => [...l, { toolName: current.toolName, preview: current.preview, wire, scopeNote }]);
    setQueueIndex((i) => i + 1);
  }

  const showPrompt = current && !alwaysAllowed.has(current.toolName);

  return (
    <Box flexDirection="column">
      <Box marginY={1} flexDirection="column">
        {log.map((entry, i) => (
          <DecisionLine key={i} entry={entry} />
        ))}
      </Box>
      {showPrompt && <PermissionPrompt key={current!.approvalId} call={current!} onDecision={handleDecision} />}
      {done && (
        <Box marginTop={1}>
          <Text bold color={TOKENS.semanticSuccess}>
            All requests resolved. Exiting...
          </Text>
        </Box>
      )}
    </Box>
  );
}

render(<App />);
