/**
 * Re-typed against Deus's real data shape, using google-gemini/gemini-cli's
 * `packages/cli/src/ui/components/messages/ToolGroupDisplay.tsx`
 * (Apache-2.0, fetched and read directly at build-sequence step 7) as the
 * VISUAL LAYOUT template only: several tool calls sharing one outer bordered
 * box, only the first entry drawing the group's top border. The real donor
 * component's actual prop is `item: HistoryItem | HistoryItemWithoutId`
 * (Gemini's `HistoryItemToolDisplayGroup`, with `tools: ToolDisplayItem[]`
 * carrying per-tool `format`/`resultSummary`/`CoreToolCallStatus` — plus a
 * `notice`-format tool-message subtype and a compact-mode toggle sourced
 * from `useSettings()`). None of `format`/`resultSummary`/notice messages/
 * compact-mode settings exist on Deus's side (no `SettingsContext`, design
 * decision #2) — dropped rather than fabricated.
 *
 * `entries: TranscriptEntry[]` is the real, minimal equivalent: a
 * contiguous run of `kind: 'tool'` entries, each rendered via
 * `ToolMessage.tsx`. `ToolCallItem.tsx` (this step's real mounting point,
 * driven by `MessageList.tsx`'s per-entry map — deliberately NOT changed by
 * this step, per that file's own header) calls this with a single-element
 * array; true multi-entry grouping needs `MessageList.tsx` to batch
 * consecutive `kind: 'tool'` entries before mapping, which is an
 * `App.tsx`/`MessageList.tsx`-level change out of this step's scope (that
 * file's header explicitly says it "should not need to change when step 7
 * lands richer tool-call rendering"). This component still does real,
 * useful, multi-entry grouping work — and is exercised as such directly by
 * this file's own tests — it simply has no >1-entry caller in the live app
 * yet. Flagged here rather than silently claimed as fully wired.
 */

import type React from 'react';
import { Box } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { ToolMessage } from './ToolMessage.js';

export interface ToolGroupDisplayProps {
  /** A contiguous run of `kind: 'tool'` entries, rendered as one shared-border group. */
  entries: TranscriptEntry[];
  terminalWidth: number;
  availableTerminalHeight?: number;
}

export const ToolGroupDisplay: React.FC<ToolGroupDisplayProps> = ({
  entries,
  terminalWidth,
  availableTerminalHeight,
}) => {
  if (entries.length === 0) return null;

  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => (
        <ToolMessage
          key={entry.id}
          entry={entry}
          terminalWidth={terminalWidth}
          availableTerminalHeight={availableTerminalHeight}
          isFirst={index === 0}
        />
      ))}
    </Box>
  );
};
