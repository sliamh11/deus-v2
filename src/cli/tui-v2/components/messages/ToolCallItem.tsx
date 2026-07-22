/**
 * Real tool-call rendering (build-sequence step 7 of
 * `~/.claude/plans/deus-tui-gemini-fork.md`), replacing the prior step's
 * flat-text placeholder. This is the tool-call mounting point
 * `MessageList.tsx` routes every `TranscriptEntry` with `kind: 'tool'`
 * through, one entry at a time (that file's per-entry `.map()` is
 * deliberately unchanged by this step — see its own header) — so this
 * component wraps its single `entry` in a one-element `ToolGroupDisplay`
 * group rather than rendering `ToolMessage` directly, keeping the real
 * multi-entry grouping component on the real render path (see
 * `ToolGroupDisplay.tsx`'s header for why it has no >1-entry caller yet).
 *
 * `terminalWidth` comes from `ink`'s `useStdout().stdout.columns` — nothing
 * upstream (`App.tsx`, `MessageList.tsx`) threads a width down yet, and
 * `DiffRenderer.tsx`/`ToolResultDisplay.tsx`/`ToolMessage.tsx` all require
 * one, so it is read locally here with a plain 80-column fallback for a
 * non-TTY/undefined `columns` (matches this repo's existing
 * `isNarrowWidth.ts` 80-column reference point).
 */

import type React from 'react';
import { useStdout } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { ToolGroupDisplay } from './ToolGroupDisplay.js';

export interface ToolCallItemProps {
  entry: TranscriptEntry;
}

const FALLBACK_TERMINAL_WIDTH = 80;

export function ToolCallItem({ entry }: ToolCallItemProps): React.ReactNode {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? FALLBACK_TERMINAL_WIDTH;

  return <ToolGroupDisplay entries={[entry]} terminalWidth={terminalWidth} />;
}
