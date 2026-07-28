// LIA-495 -> LIA-496 — pure diff-content logic ported verbatim from
// LIA-495's runtime/diffStatus.ts's `countChanges`. This part had zero
// presentation dependency and needed no change.
//
// Deviation from the S1 dispatch's literal "port byte-identical" for this
// file: LIA-495's diffPanelBorderColor imported `tokens` (CSS custom-
// property reference strings) and returned a color. Porting that import
// byte-identical would put that same presentation syntax inside
// `shared/src/` — the exact violation this repo's purity gate exists to
// fail, and the exact thing § "Build the shared package" opens by naming
// ("this package must contain ZERO presentation values"). The
// status-classification LOGIC
// (ToolCallStatus, the success/error/unknown -> border mapping, the
// self-checking assertion that a non-success status never resolves to the
// neutral value) is preserved byte-for-byte in shape; only the return type
// changed from a color string to a StatusKey from ./status, which is where
// this port's semantic-key replacement for LIA-495's tokens.ts now lives.
export type { ToolCallStatus } from "./status";
export { diffPanelBorderStatus } from "./status";

export function countChanges(diffContent: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
