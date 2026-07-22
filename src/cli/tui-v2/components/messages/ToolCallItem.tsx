/**
 * TODO(build-sequence step 7): placeholder tool-call rendering.
 *
 * This is the tool-call mounting point `MessageList.tsx` routes every
 * `TranscriptEntry` with `kind: 'tool'` through — a deliberately isolated
 * seam so step 7 (`DiffRenderer.tsx` port + `ToolMessage`/`ToolGroupDisplay`/
 * `ToolResultDisplay`, re-typed against Deus's real `ChatDisplayEvent`'s
 * `tool_use` shape) can replace this component's body without touching
 * `MessageItem.tsx`, `MessageList.tsx`, or anything upstream of it.
 *
 * Why this can't be the real thing yet: today's `TranscriptEntry` (produced
 * by `deus-tui-state.ts`'s `tuiReduce` from a `tool_use` `ChatDisplayEvent`)
 * is a flat, already-formatted `label` string — no structured tool name,
 * input, output, status, or diff payload survives past the reducer. Step 7's
 * real components need that structured shape, which is a `tuiReduce`/
 * `ChatDisplayEvent`-level change out of scope for this step (this step only
 * wires `App.tsx`/`AppContainer.tsx` to the existing bridge/reducer
 * contract, per the plan's build-sequence). Building real per-tool-call
 * visual formatting against a string that's already lost its structure would
 * be thrown away the moment step 7 lands the richer shape.
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { themeManager } from '../../themes/theme-manager.js';

export interface ToolCallItemProps {
  entry: TranscriptEntry;
}

export function ToolCallItem({ entry }: ToolCallItemProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();
  return (
    <Box>
      <Text color={semanticColors.ui.comment}>
        {'  '}
        {entry.text}
      </Text>
    </Box>
  );
}
