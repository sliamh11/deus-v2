// LIA-495 — Ink equivalent of web-first-demo's EditToolUI, itself ported
// from full-shell.tsx's EditToolUI. Same bullet convention/coloring, same
// `EditDiffResult` result shape (runtime/adapter.ts, copied verbatim),
// delegates to DiffPanel for the diff moment (a genuine library-primitive
// port on the Ink side — see DiffPanel.tsx's header comment).
import type { FC } from "react";
import { Box, Text } from "ink";
import type { ToolCallMessagePartProps } from "@assistant-ui/react-ink";
import type { EditDiffResult } from "../runtime/adapter";
import { liveBulletColor } from "../runtime/statusColor";
import type { ToolCallStatus } from "../runtime/diffStatus";
import { extractPath } from "../runtime/util";
import { BULLET, tokens } from "../runtime/tokens";
import { ToolPath } from "./ToolPath";
import { DiffPanel } from "./DiffPanel";

export const EditToolUI: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const pending = props.result === undefined;
  const isError = props.isError === true;
  const color = liveBulletColor(pending, isError);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color} bold>
          {BULLET}{" "}
        </Text>
        <Text bold>Edit</Text>
        <Text>(</Text>
        {path ? <ToolPath path={path} /> : <Text color={tokens.textMuted}>{props.argsText}</Text>}
        <Text>)</Text>
      </Box>
      {pending ? (
        <Box>
          <Text color={tokens.textMuted}>  editing…</Text>
        </Box>
      ) : (
        (() => {
          const result = props.result as EditDiffResult;
          const status: ToolCallStatus = isError ? "error" : "success";
          return <DiffPanel diffContent={result.diffContent} path={path} status={status} />;
        })()
      )}
    </Box>
  );
};
