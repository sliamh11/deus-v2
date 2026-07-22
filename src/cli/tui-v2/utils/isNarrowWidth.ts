/**
 * Ported 1:1, verbatim, from google-gemini/gemini-cli's
 * packages/cli/src/ui/utils/isNarrowWidth.ts (Apache-2.0). No dependencies,
 * no adaptation needed.
 *
 * See /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md build-sequence
 * step 4.
 */

export function isNarrowWidth(width: number): boolean {
  return width < 80;
}
