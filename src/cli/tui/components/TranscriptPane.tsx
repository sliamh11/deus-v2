/**
 * Scrollable transcript log for `deus tui` (Track B step 5 of
 * LIA-471's spec) — one row per
 * `TranscriptEntry` (already produced by `deus-tui-state.ts`'s reducer from
 * the same `ChatDisplayEvent` union the readline client renders). This is a
 * JSX-list re-expression of the switch in `deus-native-chat-client.ts`'s
 * `render()` (lines 309-385), not a new event vocabulary: `user`/`assistant`
 * mirror plain text output, `tool`/`progress` mirror the 2-space-indented
 * feedback lines, `error` mirrors the `Error: ` prefix the readline client
 * writes to its error stream. `permission_request` and `assistant_done`
 * never reach this component — the reducer routes the former to modal state
 * and treats the latter as a boundary marker with no transcript entry,
 * exactly as the readline client does.
 *
 * "Scrollable": like the readline client's plain stdout stream, this keeps
 * appending and lets the terminal's own scrollback hold history; the only
 * addition here is capping the *rendered* rows to the most recent
 * `maxVisible` so Ink doesn't have to lay out an unbounded tree every
 * keystroke in a very long session — an auto-scroll-to-bottom viewport, not
 * a manual scrollbar (no arrow-key pane scrolling in this v1, matching the
 * plan's "don't solve problems that don't exist yet" guidance until a real
 * user needs it).
 */

import { Box, Text } from 'ink';

import type { TranscriptEntry } from '../deus-tui-state.js';

export interface TranscriptPaneProps {
  entries: TranscriptEntry[];
  maxVisible?: number;
}

const DEFAULT_MAX_VISIBLE = 200;

function rowFor(entry: TranscriptEntry): React.ReactNode {
  switch (entry.kind) {
    case 'user':
      return (
        <Text color="cyan">
          {'> '}
          {entry.text}
        </Text>
      );
    case 'assistant':
      return <Text>{entry.text}</Text>;
    case 'tool':
    case 'progress':
      return (
        <Text dimColor>
          {'  '}
          {entry.text}
        </Text>
      );
    case 'error':
      return (
        <Text color="red">
          {'Error: '}
          {entry.text}
        </Text>
      );
    default: {
      const unhandled: never = entry.kind;
      void unhandled;
      return <Text>{entry.text}</Text>;
    }
  }
}

export function TranscriptPane({
  entries,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: TranscriptPaneProps): React.ReactNode {
  const visible =
    entries.length > maxVisible ? entries.slice(-maxVisible) : entries;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.length === 0 ? (
        <Text dimColor>No messages yet — type below and press Enter.</Text>
      ) : (
        visible.map((entry) => <Box key={entry.id}>{rowFor(entry)}</Box>)
      )}
    </Box>
  );
}
