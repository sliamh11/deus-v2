// LIA-496 — the ToolCallMessagePart renderer for the `Edit` tool (registered
// against `Edit` in Messages.tsx's `AssistantMessage` — confirm that link
// there, not here). Uses the REAL `DiffView` primitive from
// `@assistant-ui/react-ink` (confirmed exported at the package's top level
// by reading node_modules/@assistant-ui/react-ink/dist/index.d.ts directly,
// not assumed) — LIA-495 already found and fixed the duplicate-header bug
// this file must not reintroduce: `DiffView` renders its own
// filename + `+N`/`-N` header internally (confirmed by reading
// node_modules/@assistant-ui/react-ink/src/primitives/diff/DiffView.tsx),
// so this component supplies exactly one header line ("Proposed changes —
// not applied", shown only when the change hasn't cleanly succeeded) and
// never a second filename/count row.
import type { FC } from "react";
import { Box, Text } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import { DiffView } from "@assistant-ui/react-ink";
import { extractPath, diffPanelBorderStatus, type EditDiffResult, type ToolCallStatus } from "@lia496/shared";
import { theme, STATUS_COLOR } from "../theme";

const GLYPH = "●";

export const DiffPanel: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const pending = props.result === undefined;
  const isError = props.isError === true;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={pending ? theme.dim : isError ? theme.err : theme.dim} bold>
          {GLYPH}{" "}
        </Text>
        <Text bold>Edit</Text>
        <Text>(</Text>
        <Text color={theme.amber}>{path ?? props.argsText}</Text>
        <Text>)</Text>
      </Box>
      {pending ? (
        <Box>
          <Text color={theme.dim}> editing…</Text>
        </Box>
      ) : (
        (() => {
          const result = props.result as EditDiffResult;
          const status: ToolCallStatus = isError ? "error" : "success";
          const borderColor = STATUS_COLOR[diffPanelBorderStatus(status)];
          const notApplied = status !== "success";
          return (
            <Box flexDirection="column" marginTop={1}>
              {notApplied ? (
                <Box marginBottom={1}>
                  <Text bold color={theme.err}>
                    Proposed changes — not applied
                  </Text>
                </Box>
              ) : null}
              <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
                <DiffView patch={result.diffContent} showLineNumbers contextLines={3} maxLines={30} />
              </Box>
            </Box>
          );
        })()
      )}
    </Box>
  );
};
