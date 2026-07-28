// LIA-495 — Ink equivalent of web-first-demo's ToolPath (itself ported from
// full-shell.tsx's ToolPath/oscHyperlink/pathHyperlink). The Ink target can
// use the ORIGINAL mechanism full-shell.tsx used — a raw OSC 8 terminal
// escape sequence (`\x1b]8;;<url>\x07<label>\x1b]8;;\x07`) so a terminal
// emulator makes the printed path clickable — rather than web-first-demo's
// `<a>` substitute, which only existed because a browser has no OSC 8
// concept. Restored verbatim from full-shell.tsx.
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { FC } from "react";
import { Text } from "ink";
import { tokens } from "../runtime/tokens";

const OSC8_ESC = "";
const OSC8_BEL = "";

function oscHyperlink(url: string, label: string): string {
  return `${OSC8_ESC}]8;;${url}${OSC8_BEL}${label}${OSC8_ESC}]8;;${OSC8_BEL}`;
}

function pathHyperlink(rawPath: string): string {
  const abs = isAbsolute(rawPath) ? rawPath : resolvePath(process.cwd(), rawPath);
  return oscHyperlink(`file://${encodeURI(abs)}`, rawPath);
}

export const ToolPath: FC<{ path: string }> = ({ path }) => (
  <Text color={tokens.accentInfo}>{pathHyperlink(path)}</Text>
);
