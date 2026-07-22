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
}

const DEFAULT_MAX_VISIBLE = 200;

export function MessageList({
  entries,
  maxVisible = DEFAULT_MAX_VISIBLE,
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
          <Box key={entry.id}>
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
