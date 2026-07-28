// LIA-495 — DOM equivalent of full-shell.tsx's ToolPath/oscHyperlink/
// pathHyperlink. The ink version writes a raw OSC 8 terminal escape
// sequence (`\x1b]8;;<url>\x07<label>\x1b]8;;\x07`) so a terminal emulator
// makes the printed path clickable. A browser has a native, better-known
// mechanism for exactly that job — a real `<a>` tag — so this swaps the
// escape-sequence string-building for a plain anchor rather than emulating
// OSC 8 in the DOM (there is nothing to emulate: `<a href>` already IS the
// clickable-path primitive here). The `file://` URL construction is kept
// unchanged from pathHyperlink's intent, though a fixture path like
// SCRATCH_PATH is virtual on the web target (see runtime/virtualFs.ts) so
// the link is illustrative rather than something the browser can actually
// navigate to.
import type { FC } from "react";

const tokens = { accentInfo: "var(--cc-accent-info)" };

function fileUrl(rawPath: string): string {
  const abs = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return `file://${encodeURI(abs)}`;
}

export const ToolPath: FC<{ path: string }> = ({ path }) => (
  <a
    href={fileUrl(path)}
    style={{ color: tokens.accentInfo, textDecoration: "none" }}
    onClick={(e) => e.preventDefault()}
  >
    {path}
  </a>
);
