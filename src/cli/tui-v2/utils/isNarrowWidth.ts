/**
 * Ported 1:1, verbatim, from google-gemini/gemini-cli's
 * packages/cli/src/ui/utils/isNarrowWidth.ts (Apache-2.0). No dependencies,
 * no adaptation needed.
 *
 * See LIA-473's plan build-sequence
 * step 4.
 */

export function isNarrowWidth(width: number): boolean {
  return width < 80;
}
