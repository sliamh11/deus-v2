/**
 * Pure, lossless tokenizer for `Composer.tsx`'s live composer buffer
 * (LIA-475). Splits the raw single-line string into an ordered list of
 * `{ kind, text }` runs — concatenating every run's `text` back together
 * always reconstructs the original input exactly (lossless: no text is
 * dropped, reordered, or invented).
 *
 * Deliberately NOT a port of gemini-cli's `utils/highlight.ts`
 * `Transformation` type — that type does not exist anywhere in this repo
 * (confirmed: no `Transformation` export under `src/cli/tui-v2` or
 * `src/cli/tui`), and gemini's real highlighter is entangled with its
 * `TextBuffer`/multi-line cursor model, which `Composer.tsx` does not have
 * (single-line, append/backspace-only buffer — see that file's header).
 * This is a new, narrower tokenizer shaped for exactly what `Composer.tsx`
 * renders: one flat string in, one flat list of colorable runs out.
 *
 * Three token kinds recognized, in priority order when ranges would
 * overlap (slash > mention > paste — ties broken by this registration
 * order since `Array.prototype.sort` is stable):
 *
 * 1. `slash` — a leading `/command` token, using the exact same
 *    recognition rule `commands/registry.ts`'s `parseSlashCommandLine`
 *    already uses (starts at index 0, `/` followed by non-whitespace).
 *    Only ever occupies a prefix of the buffer; a slash command never
 *    starts mid-line (typing `foo /bar` does NOT highlight `/bar` — matches
 *    `parseSlashCommandLine`, which only recognizes a command when the
 *    ENTIRE trimmed line starts with `/`).
 * 2. `mention` — every `@path` run found anywhere in the buffer, reusing
 *    `AT_COMMAND_PATH_REGEX_SOURCE` from `at-mentions/at-mention-
 *    processor.ts` verbatim so tokenization and the real `@path` parser
 *    (`parseAllAtCommands`) never disagree about what counts as a mention.
 *    An escaped `\@` (per that module's `escapeAtSymbols`) is not matched,
 *    same as the real parser.
 * 3. `paste` — a literal `[Pasted Text: N lines]`-shaped placeholder
 *    segment. `tui-v2` has no paste-detection pipeline yet (LIA-475's plan
 *    explicitly does not add one — out of scope), so nothing in this repo
 *    ever inserts one of these into `state.input` today; this token kind
 *    exists so a *future* paste-placeholder feature renders distinctly
 *    without a second highlighter needing to be written, and so this step's
 *    verification scenario (appending a literal placeholder string and
 *    confirming distinct styling) has something real to check.
 *
 * Everything not covered by the three kinds above is a `plain` run.
 */

import { AT_COMMAND_PATH_REGEX_SOURCE } from '../at-mentions/at-mention-processor.js';

export type HighlightTokenKind = 'plain' | 'slash' | 'mention' | 'paste';

export interface HighlightToken {
  kind: HighlightTokenKind;
  text: string;
}

/** Matches a `[Pasted Text: ...]` / `[Pasted Image: ...]`-shaped placeholder segment. */
const PASTE_PLACEHOLDER_REGEX = /\[Pasted (?:Text|Image)[^\]\n]*\]/g;

interface TokenRange {
  start: number;
  end: number;
  kind: HighlightTokenKind;
}

/**
 * Collects every candidate range (O(n) per pass, three passes total), sorts
 * by start index (O(k log k) for k candidate ranges), then walks the sorted
 * list once, dropping any range that overlaps a previously-accepted one —
 * since ranges are collected slash-first, mention-second, paste-third and
 * `sort` is stable, an overlap is resolved in that same priority order.
 */
function collectRanges(value: string): TokenRange[] {
  const ranges: TokenRange[] = [];

  const slashMatch = /^\/(\S*)/.exec(value);
  if (slashMatch) {
    ranges.push({ start: 0, end: slashMatch[0].length, kind: 'slash' });
  }

  const mentionRegex = new RegExp(
    `(?<!\\\\)@${AT_COMMAND_PATH_REGEX_SOURCE}`,
    'g',
  );
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = mentionRegex.exec(value)) !== null) {
    ranges.push({
      start: mentionMatch.index,
      end: mentionMatch.index + mentionMatch[0].length,
      kind: 'mention',
    });
  }

  PASTE_PLACEHOLDER_REGEX.lastIndex = 0;
  let pasteMatch: RegExpExecArray | null;
  while ((pasteMatch = PASTE_PLACEHOLDER_REGEX.exec(value)) !== null) {
    ranges.push({
      start: pasteMatch.index,
      end: pasteMatch.index + pasteMatch[0].length,
      kind: 'paste',
    });
  }

  ranges.sort((a, b) => a.start - b.start);

  const accepted: TokenRange[] = [];
  for (const range of ranges) {
    const last = accepted[accepted.length - 1];
    if (last && range.start < last.end) continue; // overlaps a higher-priority (earlier-sorted) range — drop it
    accepted.push(range);
  }
  return accepted;
}

/**
 * Tokenizes one composer buffer into ordered, colorable runs. Empty input
 * returns an empty array (nothing to render). Concatenating every returned
 * token's `text`, in order, always equals `value` exactly.
 */
export function tokenizeComposerValue(value: string): HighlightToken[] {
  if (value === '') return [];

  const ranges = collectRanges(value);
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      tokens.push({ kind: 'plain', text: value.slice(cursor, range.start) });
    }
    tokens.push({
      kind: range.kind,
      text: value.slice(range.start, range.end),
    });
    cursor = range.end;
  }
  if (cursor < value.length) {
    tokens.push({ kind: 'plain', text: value.slice(cursor) });
  }
  return tokens;
}
