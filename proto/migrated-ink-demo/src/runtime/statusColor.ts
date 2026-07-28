// LIA-495 — ported verbatim from full-shell.tsx's liveBulletColor. Pure
// logic (pending/error → token color), no ink or DOM dependency either
// way.
import { tokens } from "./tokens";

export function liveBulletColor(pending: boolean, isError: boolean): string {
  if (pending) return tokens.textMuted;
  return isError ? tokens.semanticError : tokens.semanticSuccess;
}
