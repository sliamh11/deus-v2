/**
 * Fuzzy-filterable command palette for `deus tui` (Track B step 5 of
 * LIA-471's spec). Seeded from
 * `LOCAL_COMMANDS` — the exact same four local commands the readline
 * client's `handleLine` recognizes (`deus-native-chat-client.ts:408-447`):
 * `/plan on`, `/plan off`, `/status`, `/exit`. No new commands invented; no
 * server-visible command surface widened. Opened via `/` on an empty
 * `InputLine` (see that component); Enter here "runs" the selected command
 * by handing its literal text to `deus-tui-app.tsx`'s `handleSubmitLine` —
 * the same interpreter InputLine's own Enter uses — so the local-command
 * list is defined once, here, and not duplicated.
 *
 * Fuzzy match: a lightweight case-insensitive subsequence check (every
 * typed character must appear, in order, somewhere in the candidate). No
 * external fuzzy-matching dependency — this repo's `package.json` doesn't
 * carry one, and a 4-item static list doesn't need one.
 *
 * `useInput`'s handler is a `useCallback` with an EMPTY dependency array
 * reading current `query`/`matches`/`boundedSelected` off a ref — see
 * `InputLine.tsx`'s doc comment for why a per-render closure identity here
 * is a real dropped-keystroke bug under Ink, not just a test-timing quirk.
 */

import { useCallback, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

export const LOCAL_COMMANDS = [
  '/plan on',
  '/plan off',
  '/status',
  '/exit',
] as const;

export interface CommandPaletteProps {
  onSelect: (command: string) => void;
  onClose: () => void;
}

function fuzzyMatches(query: string, candidate: string): boolean {
  if (query === '') return true;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

export function CommandPalette({
  onSelect,
  onClose,
}: CommandPaletteProps): React.ReactNode {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = LOCAL_COMMANDS.filter((command) =>
    fuzzyMatches(query, command),
  );
  const boundedSelected =
    matches.length === 0 ? 0 : Math.min(selected, matches.length - 1);

  const latest = useRef({ matches, boundedSelected, onSelect, onClose });
  latest.current = { matches, boundedSelected, onSelect, onClose };

  const handleInput = useCallback((input: string, key: Key) => {
    const { matches, boundedSelected, onSelect, onClose } = latest.current;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(matches.length - 1, current + 1));
      return;
    }
    if (key.return) {
      const command = matches[boundedSelected];
      if (command) onSelect(command);
      else onClose();
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.tab ||
      key.meta
    ) {
      return;
    }
    if (input && !key.ctrl) {
      setQuery((current) => current + input);
      setSelected(0);
    }
  }, []);

  useInput(handleInput);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">
        Commands {query ? `— ${query}` : ''}
      </Text>
      {matches.length === 0 ? (
        <Text dimColor>No matching commands</Text>
      ) : (
        matches.map((command, index) => (
          <Text
            key={command}
            color={index === boundedSelected ? 'cyan' : undefined}
            inverse={index === boundedSelected}
          >
            {command}
          </Text>
        ))
      )}
    </Box>
  );
}
