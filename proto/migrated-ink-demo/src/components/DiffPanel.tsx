// LIA-495 — the mirror image of web-first-demo's DiffPanel gap. On the web
// target, @assistant-ui/react has no diff-view primitive at all, so
// web-first-demo hand-built a line-by-line renderer (RawDiffLines). On the
// Ink target, @assistant-ui/react-ink DOES export a real `DiffView`
// primitive (confirmed live in full-shell.tsx, which imports it from the
// package's public barrel without any deep-import workaround) — so this is
// a genuine library-primitive port, not a hand-built substitute. The
// container chrome around it (the "Proposed changes — not applied" label,
// the status-colored border) is restored verbatim from full-shell.tsx's own
// DiffPanel, which web-first-demo had already ported unchanged (that part
// never depended on a library diff primitive either way — always
// hand-rolled JSX/Ink markup over `countChanges`/`diffPanelBorderColor`,
// runtime/diffStatus.ts, copied verbatim).
//
// RECONCILE fix (code-review finding, Low): the path+/-counts row used to be
// hand-rolled here too (mirroring full-shell.tsx/web-first-demo verbatim),
// but `DiffView` itself already renders a file-name + `+N`/`-N` header
// internally (confirmed by reading dist/primitives/diff/DiffView.js) — with
// both present the panel showed the same path and counts twice in a row.
// Dropped the duplicate hand-rolled row; DiffView's own header is now the
// only one. `countChanges`/`ToolPath` imports trimmed accordingly.
import type { FC } from "react";
import { Box, Text } from "ink";
import { DiffView } from "@assistant-ui/react-ink";
import { diffPanelBorderColor, type ToolCallStatus } from "../runtime/diffStatus";
import { tokens } from "../runtime/tokens";

export const DiffPanel: FC<{
  diffContent: string;
  path?: string;
  status: ToolCallStatus;
}> = ({ diffContent, status }) => {
  const notApplied = status !== "success";
  const borderColor = diffPanelBorderColor(status);
  return (
    <Box flexDirection="column" marginTop={1}>
      {notApplied ? (
        <Box marginBottom={1}>
          <Text bold color={borderColor}>
            Proposed changes — not applied
          </Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <DiffView patch={diffContent} showLineNumbers contextLines={3} maxLines={30} />
      </Box>
    </Box>
  );
};
