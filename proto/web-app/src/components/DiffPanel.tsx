// LIA-496 — DiffPanel.tsx <- the ToolCallMessagePart renderer for the Edit
// tool (wired via `components.tools.by_name.Edit` on AssistantMessage's
// MessagePrimitive.Parts, in Thread.tsx). Ports LIA-495's proven
// RawDiffLines pattern (web-first-demo/src/components/DiffPanel.tsx),
// restyled to the s-code dark card and this app's diff colors
// (--s-diff-add #93C989 / --s-diff-del #D98D82, taken verbatim from the
// design source, not re-derived). Keeps LIA-495's FINDINGS.md fix baked
// in: the card header shows the filename exactly once (never duplicated
// against the diff's own +++ line).
import type { FC } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { countChanges, diffPanelBorderStatus, extractPath, type ToolCallStatus, type EditDiffResult } from "@lia496/shared";
import { statusColorVar } from "../statusColor";

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "s-hunk";
  if (line.startsWith("+")) return "s-add";
  if (line.startsWith("-")) return "s-del";
  return "s-ctx";
}

const RawDiffLines: FC<{ diffContent: string }> = ({ diffContent }) => (
  <pre>
    {diffContent.split("\n").map((line, i) => (
      // eslint-disable-next-line react/no-array-index-key -- static fixture text, order never changes
      <div key={i} className={diffLineClass(line)}>
        {line || " "}
      </div>
    ))}
  </pre>
);

function toolCallStatus(props: ToolCallMessagePartProps): ToolCallStatus {
  if (props.result === undefined) return "unknown";
  return props.isError ? "error" : "success";
}

export const DiffPanel: FC<ToolCallMessagePartProps> = (props) => {
  const path = extractPath(props.args);
  const status = toolCallStatus(props);
  const result = props.result as EditDiffResult | undefined;

  if (!result || result.type !== "diff") {
    // Still running / no result yet — nothing to show but the fact a diff
    // is coming; ActiveStatusRow-equivalent affordance is out of scope for
    // this card (the thread-level "running" state already covers it).
    return null;
  }

  const { additions, deletions } = countChanges(result.diffContent);
  const notApplied = status !== "success";
  const borderStatus = diffPanelBorderStatus(status);

  return (
    <div className="s-diff-wrap">
      {notApplied && (
        <div
          className={`s-diff-flag${status === "error" ? " error" : " notapplied"}`}
          style={{ color: statusColorVar(borderStatus) }}
        >
          Proposed changes — not applied
        </div>
      )}
      <div className="s-code" style={{ border: `1px solid ${statusColorVar(borderStatus)}` }}>
        <div className="s-code-h">
          <span>{path ?? result.filename}</span>
          <span>
            <span className="plus">+{additions}</span> <span className="minus">−{deletions}</span>
          </span>
        </div>
        <RawDiffLines diffContent={result.diffContent} />
      </div>
    </div>
  );
};
