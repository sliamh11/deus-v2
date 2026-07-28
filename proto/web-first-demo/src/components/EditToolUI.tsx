// LIA-495 — ported from full-shell.tsx's EditToolUI: same bullet
// convention/coloring, same `EditDiffResult` result shape, delegates to
// DiffPanel for the diff moment (hand-built on web — see DiffPanel.tsx's
// header comment for why).
import type { FC } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
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
    <div style={{ marginBottom: 16 }}>
      <div>
        <span style={{ color, fontWeight: 700 }}>{BULLET} </span>
        <span style={{ fontWeight: 700 }}>Edit</span>
        <span>(</span>
        {path ? <ToolPath path={path} /> : <span style={{ color: tokens.textMuted }}>{props.argsText}</span>}
        <span>)</span>
      </div>
      {pending ? (
        <div style={{ paddingLeft: 16, color: tokens.textMuted }}>editing…</div>
      ) : (
        (() => {
          const result = props.result as EditDiffResult;
          const status: ToolCallStatus = isError ? "error" : "success";
          return <DiffPanel diffContent={result.diffContent} path={path} status={status} />;
        })()
      )}
    </div>
  );
};
