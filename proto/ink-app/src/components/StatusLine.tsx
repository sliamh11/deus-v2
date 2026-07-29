// LIA-496 IB1 (I5) — ← App.tsx (`MainPane`, confirm that link there, not
// here), rendered once, dynamically, directly above `Composer`. Replaces
// the old boxed header row's live status half (`App.tsx:167-182`'s
// `model: sonnet-5` text) and old `Sidebar.tsx`'s footer
// (`Sidebar.tsx:260-263`, which also hardcoded the identity this file
// sanitizes — see `identity.ts`'s header comment). The other half of the
// old header (product name/model, static per-session) moved into
// `committedBlocks.tsx`'s once-printed identity banner instead — this line
// is only the parts that are genuinely LIVE (current cwd, and the two
// keybindings this batch actually wires).
import type { FC } from "react";
import { Box, Text } from "ink";
import { theme, STATUS_COLOR } from "../theme";
import { getCwdLabel, MODEL_NAME } from "../identity";

export const StatusLine: FC = () => (
  <Box paddingX={2}>
    <Text color={theme.dim}>
      <Text color={STATUS_COLOR.ok}>{MODEL_NAME}</Text>
      {" · "}
      {getCwdLabel()}
      {" · ctrl+t threads · ctrl+n new"}
    </Text>
  </Box>
);
