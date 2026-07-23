/**
 * Renders one non-tool `TranscriptEntry` (`user` / `assistant` / `progress` /
 * `error`). Split out from `MessageList.tsx` as its own component — a
 * distinct seam from `ToolCallItem.tsx` — so build-sequence step 7's
 * `DiffRenderer.tsx`/`ToolMessage`/`ToolGroupDisplay`/`ToolResultDisplay`
 * work only ever touches the tool-call seam, never this one. Colors come
 * from the ported theme system (`themes/theme-manager.ts`), replacing
 * `tui/components/TranscriptPane.tsx`'s hardcoded `cyan`/`red` named colors.
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { themeManager } from '../../themes/theme-manager.js';

export interface MessageItemProps {
  entry: TranscriptEntry;
}

export function MessageItem({ entry }: MessageItemProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();

  switch (entry.kind) {
    case 'user':
      return (
        <Text color={semanticColors.text.accent}>
          {'> '}
          {entry.text}
        </Text>
      );
    case 'assistant':
      return <Text color={semanticColors.text.response}>{entry.text}</Text>;
    case 'progress':
      return (
        <Text color={semanticColors.text.secondary}>
          {'  '}
          {entry.text}
        </Text>
      );
    case 'error':
      return (
        <Text color={semanticColors.status.error}>
          {'Error: '}
          {entry.text}
        </Text>
      );
    case 'tool':
      // Never reached — MessageList.tsx routes 'tool' entries to
      // ToolCallItem.tsx instead. Kept as an exhaustive case (not `default`)
      // so adding a TranscriptEntryKind without updating the routing in
      // MessageList.tsx is a compile error here, not a silent fallthrough.
      return <Text>{entry.text}</Text>;
    default: {
      const unhandled: never = entry.kind;
      void unhandled;
      return <Box />;
    }
  }
}
