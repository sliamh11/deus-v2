#!/usr/bin/env node
/**
 * LIA-494 prototype -- screen 1: the three-way permission-prompt flow.
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
 * NAMING COLLISION NOTE: nothing in this file is Deus's own `ChatTransport`
 * (`deus-v2-mvp/src/cli/deus-native-chat-client.ts:125`, a `turn()`/
 * `respondPermission()`/`setPlanMode()` interface) -- that's an unrelated,
 * same-named concept belonging to Deus's real IPC layer. This file has no
 * transport at all; it is pure UI driven by an in-memory demo queue.
 */
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput, useApp, type Key } from 'ink';

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
  input: string; // pre-stringified preview, mirrors the real modal's toolInputPreview
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
 * Ported verbatim (logic only) from the real, independently oracle-tested
 * `permissionListKeyToResult` in deus-tui-permission-decision-v2.ts. Boundary
 * policy is the oracle's pinned choice: HARD-CLAMP at both ends -- Up at
 * index 0 / Down at the last index is a no-op, not a move.
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
 * above this boundary (see the `alwaysAllowed` Set in <App> below), and only
 * a plain `approved: boolean` ever crosses it.
 */
function toLibraryResponse(
  decision: PermissionDecision,
): AgentTUIToolApprovalResponse {
  if (decision === 'deny') return { approved: false, reason: 'Denied by user.' };
  return { approved: true };
}

// ---------------------------------------------------------------------------
// Demo queue -- "Bash" deliberately repeats so the allow_always persistence
// (auto-resolve with NO prompt the 2nd time) is visible in the capture.
// ---------------------------------------------------------------------------

const QUEUE: PendingToolCall[] = [
  { approvalId: 'appr_1', toolCallId: 'call_1', toolName: 'Bash', input: 'npm test' },
  {
    approvalId: 'appr_2',
    toolCallId: 'call_2',
    toolName: 'WriteFile',
    input: 'src/index.ts (42 lines)',
  },
  { approvalId: 'appr_3', toolCallId: 'call_3', toolName: 'Bash', input: 'git status' },
  {
    approvalId: 'appr_4',
    toolCallId: 'call_4',
    toolName: 'WebFetch',
    input: 'https://example.com/pricing',
  },
];

interface DecisionLogEntry {
  toolName: string;
  input: string;
  label: string;
  wire: AgentTUIToolApprovalResponse;
}

const DENY_TIMEOUT_MS = 15_000;
const TICK_MS = 250;
const SELECTED_MARK = '●';
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

  useEffect(() => {
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, deadline - Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  useInput((_input: string, key: Key) => {
    const result = permissionListKeyToResult(cursorIndex, {
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
    });
    if (result.type === 'move') setCursorIndex(result.index);
    else if (result.type === 'resolve') onDecision(result.decision);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission requested
      </Text>
      <Text>
        Tool: <Text bold>{call.toolName}</Text>
      </Text>
      <Text>Input: {call.input}</Text>
      <Text color="gray">(auto-denies in {Math.ceil(remainingMs / 1000)}s)</Text>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_LIST_OPTIONS.map((option, index) => {
          const isSelected = index === cursorIndex;
          const isAlwaysAllow = option.decision === 'allow_always';
          const color = isSelected ? 'cyanBright' : isAlwaysAllow ? 'cyan' : 'gray';
          return (
            <Text key={option.decision} color={color} bold={isSelected}>
              {isSelected ? SELECTED_MARK : UNSELECTED_MARK} {option.label}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">(↑/↓ to move, Enter to confirm)</Text>
    </Box>
  );
}

function DecisionLine({ entry }: { entry: DecisionLogEntry }) {
  // Wire-honest glyph: approved -> green check, denied -> red X. Never a
  // green check on a denied/failed decision (same discipline as screen 2's
  // statusGlyph, applied here to the permission wire result instead of a
  // tool-call result).
  const glyph = entry.wire.approved ? '✓' : '✗';
  const color = entry.wire.approved ? 'green' : 'red';
  return (
    <Text>
      <Text color={color}>{glyph}</Text> <Text bold>{entry.toolName}</Text>{' '}
      <Text color="gray">({entry.input})</Text> -&gt; <Text color={color}>{entry.label}</Text>
      <Text color="gray">
        {' '}
        [wire: approved={String(entry.wire.approved)}
        {entry.wire.reason ? `, reason="${entry.wire.reason}"` : ''}]
      </Text>
    </Text>
  );
}

function App() {
  const { exit } = useApp();
  const [queueIndex, setQueueIndex] = useState(0);
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
          input: current.input,
          label: 'auto-approved (always-allow, no prompt)',
          wire,
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
    const label =
      decision === 'allow_once' ? 'Allow once' : decision === 'allow_always' ? 'Always allow' : 'Deny';
    setLog((l) => [...l, { toolName: current.toolName, input: current.input, label, wire }]);
    setQueueIndex((i) => i + 1);
  }

  const showPrompt = current && !alwaysAllowed.has(current.toolName);

  return (
    <Box flexDirection="column">
      <Text bold>LIA-494 -- @ai-sdk/tui prototype: three-way permission prompt</Text>
      <Text color="gray">
        allow_once / allow_always / deny -- mapped onto the library's binary approved/reason wire
        shape at the boundary only
      </Text>
      <Box marginY={1} flexDirection="column">
        {log.map((entry, i) => (
          <DecisionLine key={i} entry={entry} />
        ))}
      </Box>
      {showPrompt && <PermissionPrompt key={current!.approvalId} call={current!} onDecision={handleDecision} />}
      {done && (
        <Box marginTop={1}>
          <Text bold color="green">
            All requests resolved. Exiting...
          </Text>
        </Box>
      )}
    </Box>
  );
}

render(<App />);
