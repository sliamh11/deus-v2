// LIA-496 — rendered via `ErrorPrimitive` (real primitive, not a
// hand-rolled check of message status). Wired from Messages.tsx's
// `AssistantMessage`, wrapped in `ErrorPrimitive.Root` (confirm that link
// there, not here) — `ErrorPrimitive.Root` itself renders nothing unless
// `useMessageError()` finds a real `message.status = {type:"incomplete",
// reason:"error", ...}` (confirmed by reading
// node_modules/@assistant-ui/core/src/react/primitive-hooks/
// useMessageError.ts directly), so this component only ever mounts for a
// genuinely errored message — currently the "theme-swap-crash" seeded
// thread (shared/src/fixtures/conversations.ts's `themeSwapCrashScript`,
// which throws a real `Error` out of its `run()` generator; see that
// script's own header comment for the exact mechanism).
import type { FC } from "react";
import { Box, Text } from "ink";
import { ErrorPrimitive } from "@assistant-ui/react-ink";
import { theme } from "../theme";

export const ErrorState: FC = () => (
  <Box borderStyle="round" borderColor={theme.err} paddingX={1} marginY={1}>
    <Text bold color={theme.err}>
      ✕{" "}
    </Text>
    <ErrorPrimitive.Message />
  </Box>
);
