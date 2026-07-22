/**
 * Re-typed against Deus's real data shape, using google-gemini/gemini-cli's
 * `packages/cli/src/ui/components/messages/ToolResultDisplay.tsx`
 * (Apache-2.0, fetched and read directly at build-sequence step 7) as the
 * VISUAL LAYOUT template only — its actual `resultDisplay: string | object`
 * prop is a big dispatch over `isSubagentProgress`/`isStructuredToolResult`/
 * `fileDiff`/`AnsiOutput` (all `@google/gemini-cli-core` concepts) plus
 * `MarkdownDisplay`/`AnsiOutputText`/`Scrollable`/`ScrollableList` (none
 * ported into `tui-v2`). None of that exists on Deus's side of the wire.
 *
 * The controlling fact (`src/cli/deus-native-chat.ts`'s real
 * `ChatDisplayEvent` union, read directly before writing this file): the
 * `tool_use` variant is `{ kind: 'tool_use'; label: string }` — a single,
 * already-resolved, flat label string. No status enum, no structured
 * input/output, no diff payload survives the daemon boundary; that module's
 * own header explicitly lists "no invented tool-result event" as a stated
 * non-goal ("the RuntimeEvent contract has no tool-result variant"). So the
 * ONLY content this component can honestly receive from real production
 * data today is text — `ToolCallItem.tsx` (this build-sequence step's real
 * mounting point) always supplies the `text` variant, built directly from
 * `TranscriptEntry.text`.
 *
 * `ToolResultContent`'s `diff` variant is a genuinely new, Deus-local type
 * (not a Gemini port — Gemini's own `fileDiff` shape doesn't survive the
 * client boundary either) added so `DiffRenderer.tsx` (this same
 * build-sequence step) has a real, typed, *tested* call site rather than
 * shipping as an orphaned port with zero callers anywhere in the app —
 * matching the precedent build-sequence steps 3-4 already set (theme
 * system, `CodeColorizer.tsx` both landed ahead of their first real
 * production caller). It has NO producer in the live render path today:
 * nothing in `ChatDisplayEvent`/`TranscriptEntry` carries diff content yet.
 * Wiring a real producer needs a `ChatDisplayEvent`/`RuntimeEvent`-level
 * change — out of scope here, and explicitly a non-goal of
 * `deus-native-chat.ts` today. Exercised only by this file's own tests
 * until that backend capability lands.
 */

import type React from 'react';
import { Box, Text } from 'ink';

import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { DiffRenderer } from './DiffRenderer.js';

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'diff'; diffContent: string; filename?: string };

export interface ToolResultDisplayProps {
  result: ToolResultContent;
  terminalWidth: number;
  availableTerminalHeight?: number;
}

export const ToolResultDisplay: React.FC<ToolResultDisplayProps> = ({
  result,
  terminalWidth,
  availableTerminalHeight,
}) => {
  switch (result.type) {
    case 'text':
      if (result.text.trim() === '') return null;
      return (
        <MaxSizedBox
          maxWidth={terminalWidth}
          maxHeight={availableTerminalHeight}
        >
          <Text wrap="wrap">{result.text}</Text>
        </MaxSizedBox>
      );
    case 'diff':
      return (
        <Box flexDirection="column">
          <DiffRenderer
            diffContent={result.diffContent}
            filename={result.filename}
            terminalWidth={terminalWidth}
            availableTerminalHeight={availableTerminalHeight}
          />
        </Box>
      );
    default: {
      const unhandled: never = result;
      void unhandled;
      return null;
    }
  }
};
