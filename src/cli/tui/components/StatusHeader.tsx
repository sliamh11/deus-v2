/**
 * Persistent status bar for `deus tui` (Track B step 5 of
 * LIA-471's spec). Renders the
 * same `NativeChatStatus` fields the readline client's `renderMode`/
 * `renderStatus` functions already print
 * (`deus-native-chat-client.ts:259-275`) — backend, mode + permission
 * profile, session id, and connection state (`status.state`, `'new'` or
 * `'resumed'`) — no new fields invented. The full diagnostic dump (including
 * `output`) is still available on demand via the `/status` local command,
 * which appends it to the transcript (see `deus-tui-app.tsx`'s
 * `formatStatus`); this header is the compact always-visible summary.
 */

import { Box, Text } from 'ink';

import type { NativeChatStatus } from '../../deus-native-chat.js';

export interface StatusHeaderProps {
  status: NativeChatStatus | undefined;
}

export function StatusHeader({ status }: StatusHeaderProps): JSX.Element {
  if (!status) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Connecting…</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        Backend: <Text bold>{status.backend}</Text>
        {'   '}
        Mode: <Text bold>{status.mode}</Text> ({status.permissionProfile})
        {'   '}
        Session: <Text bold>{status.sessionId ?? 'not started'}</Text>
        {'   '}
        State: <Text bold>{status.state}</Text>
      </Text>
    </Box>
  );
}
