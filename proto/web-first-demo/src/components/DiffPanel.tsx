// LIA-495 — the honest gap this port's setup stage flagged: the ink demo's
// DiffPanel wraps the library's own `DiffView` primitive
// (`@assistant-ui/react-ink` exports it, confirmed live by importing it in
// full-shell.tsx). `@assistant-ui/react` — the web package — has NO
// diff-view primitive at all: grepping the entire @assistant-ui/ node_modules
// tree (react, core, store, tap, react-markdown) for "diff" in any case
// returns zero matches outside react-ink. There is no DiffPrimitive family,
// no DiffView, nothing to import.
//
// So the line-by-line diff renderer below (`RawDiffLines`) is HAND-BUILT,
// not a port of anything — it exists only to fill the gap so this file's
// item 4 ("a tool call with a diff moment") has something real to show on
// the web target. The container chrome around it (OSC-8-hyperlink-turned-
// `<a>` path, +/- counts, the "Proposed changes — not applied" label, the
// status-colored border) IS ported verbatim from full-shell.tsx's
// DiffPanel — that part has no library dependency either version, it was
// always hand-rolled JSX/Ink markup over `countChanges`/
// `diffPanelBorderColor` (runtime/diffStatus.ts, ported unchanged).
import type { FC } from "react";
import { countChanges, diffPanelBorderColor, type ToolCallStatus } from "../runtime/diffStatus";
import { tokens } from "../runtime/tokens";
import { ToolPath } from "./ToolPath";

function diffLineColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return tokens.accentInfo;
  }
  if (line.startsWith("+")) return tokens.semanticSuccess;
  if (line.startsWith("-")) return tokens.semanticError;
  return tokens.textMuted;
}

const RawDiffLines: FC<{ diffContent: string }> = ({ diffContent }) => (
  <pre
    style={{
      margin: 0,
      fontFamily: "var(--cc-mono)",
      fontSize: 13,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    }}
  >
    {diffContent.split("\n").map((line, i) => (
      // eslint-disable-next-line react/no-array-index-key -- static fixture text, order never changes
      <div key={i} style={{ color: diffLineColor(line) }}>
        {line || " "}
      </div>
    ))}
  </pre>
);

export const DiffPanel: FC<{
  diffContent: string;
  path?: string;
  status: ToolCallStatus;
}> = ({ diffContent, path: relPath, status }) => {
  const { additions, deletions } = countChanges(diffContent);
  const notApplied = status !== "success";
  const borderColor = diffPanelBorderColor(status);

  return (
    <div style={{ marginTop: 8 }}>
      {relPath ? (
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "baseline" }}>
          <ToolPath path={relPath} />
          <span style={{ color: tokens.semanticSuccess }}>+{additions}</span>
          <span style={{ color: tokens.semanticError }}>-{deletions}</span>
        </div>
      ) : null}
      {notApplied ? (
        <div style={{ marginBottom: 8, fontWeight: 700, color: borderColor }}>
          Proposed changes — not applied
        </div>
      ) : null}
      <div
        style={{
          border: `1px solid ${borderColor}`,
          borderRadius: 6,
          padding: "8px 12px",
          overflowX: "auto",
          background: "var(--cc-bg-surface)",
        }}
      >
        <RawDiffLines diffContent={diffContent} />
      </div>
    </div>
  );
};
