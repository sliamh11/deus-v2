// LIA-495 — ported verbatim from full-shell.tsx's extractPath. Pure logic,
// no ink/DOM dependency either way — unchanged for the web target.
export function extractPath(args: unknown): string | undefined {
  if (args && typeof args === "object" && "path" in (args as Record<string, unknown>)) {
    const p = (args as { path?: unknown }).path;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}
