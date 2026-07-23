/**
 * Message-list mounting point for `tui-v2`'s `App.tsx` — the scrollable
 * transcript area. Adapted from `tui/components/TranscriptPane.tsx`'s
 * auto-scroll-to-bottom viewport (cap rendered rows to the most recent
 * `maxVisible`, let the terminal's own scrollback hold full history), but
 * splits row rendering into two distinct seams instead of one flat switch:
 * `kind: 'tool'` entries route to `ToolCallItem.tsx` (the tool-call mounting
 * point, replaced wholesale in build-sequence step 7), everything else
 * routes to `MessageItem.tsx`. Neither this file nor `MessageItem.tsx`
 * should need to change when step 7 lands richer tool-call rendering.
 *
 * `activeMatchEntryId` (build-sequence step 9's Ctrl+F addition) marks the
 * row `search/transcript-search.ts`'s current match points at with a
 * left-border accent — a lightweight "you are here" cue rather than
 * per-character highlighting inside the row's own text (`MessageItem.tsx`/
 * `ToolCallItem.tsx` render plain `<Text>`, not a span-splittable rich-text
 * tree yet — see `ToolCallItem.tsx`'s header for why tool rows in
 * particular are still a flat string).
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { themeManager } from '../../themes/theme-manager.js';
import { MessageItem } from './MessageItem.js';
import { ToolCallItem } from './ToolCallItem.js';

export interface MessageListProps {
  entries: TranscriptEntry[];
  maxVisible?: number;
  /** The transcript entry `search/transcript-search.ts`'s current match is in, if a search is active with at least one match. */
  activeMatchEntryId?: number;
}

const DEFAULT_MAX_VISIBLE = 200;

export function MessageList({
  entries,
  maxVisible = DEFAULT_MAX_VISIBLE,
  activeMatchEntryId,
}: MessageListProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  const visible =
    entries.length > maxVisible ? entries.slice(-maxVisible) : entries;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.length === 0 ? (
        <Text color={semanticColors.text.secondary}>
          No messages yet — type below and press Enter.
        </Text>
      ) : (
        visible.map((entry) => (
          <Box
            key={entry.id}
            borderStyle={entry.id === activeMatchEntryId ? 'round' : undefined}
            borderColor={
              entry.id === activeMatchEntryId ? semanticColors.ui.focus : undefined
            }
          >
            {entry.kind === 'tool' ? (
              <ToolCallItem entry={entry} />
            ) : (
              <MessageItem entry={entry} />
            )}
          </Box>
        ))
      )}
    </Box>
  );
}
