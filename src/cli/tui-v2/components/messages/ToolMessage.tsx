/**
 * Re-typed against Deus's real data shape, using google-gemini/gemini-cli's
 * `packages/cli/src/ui/components/messages/ToolMessage.tsx` (Apache-2.0,
 * fetched and read directly at build-sequence step 7) as the VISUAL LAYOUT
 * template only: a header line (status glyph + tool name/label) above a
 * bordered result body. The real donor component's actual props
 * (`ToolMessageProps extends IndividualToolCallDisplay`) are typed against
 * `CoreToolCallStatus`/`Kind`/`Config` from `@google/gemini-cli-core`
 * (`callId`, `progress`/`progressTotal` for a live MCP progress bar,
 * `activeShellPtyId`/`embeddedShellFocused`/`ptyId` for an embedded shell
 * PTY, `config` for shell-focusability checks) — none of which exist on
 * Deus's side. Deus's tool execution happens entirely in the daemon
 * (`middleware-stack.ts`'s `wrapToolCall`, per the plan's "Critical
 * reconciled finding"); the client never runs a shell PTY, never sees MCP
 * progress ticks, and never observes a live per-call status transition — by
 * the time a `tool_use` `ChatDisplayEvent` reaches this component, the call
 * has already resolved (`NativeChatStatus.output` is `'buffered'` today,
 * confirmed in `deus-native-chat.ts`). So there is no real "Executing"/
 * "AwaitingApproval" state to render a spinner for — the status glyph below
 * is intentionally static (always the resolved/done glyph), not a fabricated
 * live-status simulation. `StickyHeader` (Gemini's alternate-buffer sticky
 * positioning) is dropped: `tui-v2` renders into the normal scrollback
 * buffer, not Gemini's alternate screen buffer, so there is nothing for a
 * sticky header to stick to yet (no alternate-buffer mode exists anywhere in
 * `tui-v2`) — a plain bordered `Box`, matching the style already established
 * by `StatusHeader.tsx`/`ToolCallItem.tsx`, replaces it.
 *
 * `entry` is `TranscriptEntry` (`src/cli/tui-v2/deus-tui-state.ts`,
 * `kind: 'tool'`) — the real shape `tuiReduce` produces from a `tool_use`
 * `ChatDisplayEvent`. `entry.text` IS the whole label (`tuiReduce` builds it
 * straight from `ChatDisplayEvent`'s `tool_use.label`, nothing more granular
 * survives) — it is rendered once, in the header line. `result` is an
 * explicit, OPTIONAL second body box, deliberately NOT defaulted from
 * `entry.text`: today's real event has no content beyond the label, and
 * echoing that same string a second time in a "result" box below it would
 * be pure duplication, not real information. `result` exists for the case
 * this component genuinely needs to prove out per this build-sequence step
 * (a caller with real structured output, including a diff — see
 * `ToolResultDisplay.tsx`'s header for why that variant currently has no
 * live producer) — exercised directly by this file's own tests, and ready
 * for `ToolCallItem.tsx` to pass through once `ChatDisplayEvent` carries
 * something richer than a flat label.
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { themeManager } from '../../themes/theme-manager.js';
import {
  ToolResultDisplay,
  type ToolResultContent,
} from './ToolResultDisplay.js';

export interface ToolMessageProps {
  /** Must be a `kind: 'tool'` entry — the tool-call mounting point's real shape. */
  entry: TranscriptEntry;
  terminalWidth: number;
  availableTerminalHeight?: number;
  /** Suppresses the top border when rendered inside a `ToolGroupDisplay` group. */
  isFirst?: boolean;
  /** Defaults to `{ type: 'text', text: entry.text }` — see file header. */
  result?: ToolResultContent;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  entry,
  terminalWidth,
  availableTerminalHeight,
  isFirst = true,
  result,
}) => {
  const semanticColors = themeManager.getSemanticColors();

  return (
    <Box flexDirection="column" width={terminalWidth}>
      <Box
        borderStyle="round"
        borderColor={semanticColors.border.default}
        borderTop={isFirst}
        borderBottom={!result}
        borderLeft={true}
        borderRight={true}
        paddingX={1}
      >
        {/* Static resolved-state glyph — see header comment: no live status
            observable client-side, so no spinner/pending glyph is fabricated. */}
        <Text color={semanticColors.status.success}>{'✓ '}</Text>
        <Text bold color={semanticColors.text.primary} wrap="truncate-end">
          {entry.text}
        </Text>
      </Box>
      {result && (
        <Box
          borderStyle="round"
          borderColor={semanticColors.border.default}
          borderTop={false}
          borderBottom={true}
          borderLeft={true}
          borderRight={true}
          paddingX={1}
          flexDirection="column"
        >
          <ToolResultDisplay
            result={result}
            terminalWidth={terminalWidth - 2}
            availableTerminalHeight={availableTerminalHeight}
          />
        </Box>
      )}
    </Box>
  );
};
