/**
 * Persistent status bar for `tui-v2`. Copied from `tui/components/StatusHeader.tsx`
 * (not imported — see `deus-chat-stream-bridge.ts`'s report on why `tui-v2`
 * copies rather than imports from `tui/`: the two packages are meant to stay
 * independently buildable during the transition) and restyled to pull its
 * border/text colors from the ported theme system (`themes/theme-manager.ts`)
 * instead of Ink's hardcoded named colors, per this step's "use the theme
 * system for styling" instruction. Field set and content are otherwise
 * unchanged — the same `NativeChatStatus` fields the readline client's
 * `renderStatus` prints (`deus-native-chat-client.ts:259-275`).
 */

import type React from 'react';
import { Box, Text } from 'ink';

import type { NativeChatStatus } from '../../deus-native-chat.js';
import { themeManager } from '../themes/theme-manager.js';

export interface StatusHeaderProps {
  status: NativeChatStatus | undefined;
}

export function StatusHeader({ status }: StatusHeaderProps): React.ReactNode {
  const semanticColors = themeManager.getSemanticColors();

  if (!status) {
    return (
      <Box
        borderStyle="round"
        borderColor={semanticColors.border.default}
        paddingX={1}
      >
        <Text color={semanticColors.text.secondary}>Connecting…</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={semanticColors.border.default}
      paddingX={1}
    >
      <Text color={semanticColors.text.primary}>
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
