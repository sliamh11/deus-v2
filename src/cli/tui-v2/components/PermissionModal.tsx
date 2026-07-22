/**
 * Permission-request modal for `tui-v2` (build-sequence step 8), restyled to
 * Gemini's arrow-key `RadioButtonSelect` + Enter interaction chrome per the
 * plan's resolved design decision #3
 * (`~/.claude/plans/deus-tui-gemini-fork.md`). This REPLACES the step-6
 * TEMPORARY typed-letter placeholder that lived at this same path — that
 * placeholder copied `tui/components/PermissionModal.tsx`'s y/a/n buffer
 * model verbatim; this is the real step-8 restyle the plan called for.
 *
 * Visual reference only (fetched and read directly, never imported):
 * google-gemini/gemini-cli's `components/shared/RadioButtonSelect.tsx` +
 * `BaseSelectionList.tsx` — the selected-row `●` marker (vs. a blank space
 * for unselected rows) and highlighting the selected row's text with the
 * theme's focus color is that component's real convention, reproduced here
 * directly rather than porting the (much more general, scroll-window-aware)
 * component itself, since this modal only ever renders a fixed 3-item list.
 * None of Gemini's own `ToolConfirmationMessage.tsx` confirmation LOGIC is
 * reused — this component drives Deus's real 3-way `allow_once`/
 * `allow_always`/`deny` contract exclusively through
 * `deus-tui-permission-decision-v2.ts`'s oracle-tested
 * `permissionListKeyToResult`, which is called by the reducer
 * (`deus-tui-state.ts`), never inline here.
 *
 * Ownership split (mirrors the retired modal's, adjusted for the new
 * model): the cursor index lives in global `TuiState.permission.cursorIndex`
 * (`deus-tui-state.ts`), not component-local state — so this component is a
 * pure view over `cursorIndex` plus the live countdown, and forwards every
 * keystroke upward via `onKeypress` unchanged (translated from Ink's `Key`
 * shape to the pure function's `PermissionListKeypress` shape only — no
 * interpretation happens here). It never calls `permissionListKeyToResult`
 * itself (that stays exclusively in `tuiReduce`, the single source of truth
 * per the plan's design decision #2) and never resolves or posts a decision
 * itself, matching the retired modal's same deliberate separation
 * (`deus-chat-stream-bridge.ts`'s `respondPermission` is the one place that
 * resolves AND posts, exactly once).
 *
 * `allow_always` visual distinctness carries forward the retired modal's
 * already-solved detail (its `PREVIEW_LABEL` map, which gave the escalating,
 * persistent grant its own wording so it never looked like just another
 * choice). In a simultaneously-visible list — unlike the old one-line
 * typed-buffer preview — that same intent maps onto always tinting the
 * "Always allow" row with the theme's accent color, regardless of cursor
 * position, layered underneath the normal selected/unselected highlight the
 * other two rows get.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

import { DENY_TIMEOUT_MS } from '../../../agent-runtimes/permission-registry.js';
import {
  PERMISSION_LIST_OPTIONS,
  type PermissionListKeypress,
} from '../deus-tui-permission-decision-v2.js';
import { themeManager } from '../themes/theme-manager.js';

export interface PermissionModalProps {
  toolName: string;
  toolInputPreview: string;
  /** Index of the currently-highlighted row in `PERMISSION_LIST_OPTIONS` — owned by `TuiState`, not this component. */
  cursorIndex: number;
  /** Forwards every Up/Down/Enter (and inert) keystroke upward unchanged; this component never resolves a decision itself. */
  onKeypress: (key: PermissionListKeypress) => void;
}

const TICK_MS = 250;
const SELECTED_MARK = '●';
const UNSELECTED_MARK = ' ';

export function PermissionModal({
  toolName,
  toolInputPreview,
  cursorIndex,
  onKeypress,
}: PermissionModalProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const [deadline] = useState(() => Date.now() + DENY_TIMEOUT_MS);
  const [remainingMs, setRemainingMs] = useState(DENY_TIMEOUT_MS);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, deadline - Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  useInput((_input: string, key: Key) => {
    onKeypress({
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
    });
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={semanticColors.status.warning}
      paddingX={1}
    >
      <Text bold color={semanticColors.status.warning}>
        Permission requested
      </Text>
      <Text color={semanticColors.text.primary}>
        Tool: <Text bold>{toolName}</Text>
      </Text>
      <Text color={semanticColors.text.primary}>
        Input: {toolInputPreview}
      </Text>
      <Text color={semanticColors.text.secondary}>
        (auto-denies in {Math.ceil(remainingMs / 1_000)}s)
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_LIST_OPTIONS.map((option, index) => {
          const isSelected = index === cursorIndex;
          const isAlwaysAllow = option.decision === 'allow_always';
          const color = isSelected
            ? semanticColors.ui.focus
            : isAlwaysAllow
              ? semanticColors.text.accent
              : semanticColors.text.secondary;
          return (
            <Text key={option.decision} color={color} bold={isSelected}>
              {isSelected ? SELECTED_MARK : UNSELECTED_MARK} {option.label}
            </Text>
          );
        })}
      </Box>
      <Text color={semanticColors.text.secondary}>
        (↑/↓ to move, Enter to confirm)
      </Text>
    </Box>
  );
}
