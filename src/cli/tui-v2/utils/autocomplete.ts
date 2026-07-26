/**
 * Pure trigger-extraction / filtering / replacement logic for `Composer.tsx`'s
 * slash-command and `@`-mention autocomplete (LIA-475). No Ink/React import,
 * no filesystem access — same functional-core convention as
 * `deus-tui-state.ts`/`commands/registry.ts`: this module is independently
 * testable with plain strings and fake data, and the one real side-effecting
 * piece (listing a directory) is an injected async adapter the CALLER
 * supplies (the real implementation lives in `AppContainer.tsx`, mirroring
 * `at-mentions/at-mention-processor.ts`'s own injected-`fs`-deps pattern).
 *
 * `Composer.tsx` has no cursor-movement keys yet (arrows are no-ops — see
 * that file's header), so the caret is always at the END of `value`. Both
 * triggers below are therefore defined purely in terms of the tail of the
 * buffer, not an explicit cursor index.
 *
 * `AutocompleteTarget` is a discriminated union on `kind`:
 * - `'slash'` — the ENTIRE buffer is `/` followed by zero or more
 *   non-whitespace characters (matches `commands/registry.ts`'s
 *   `parseSlashCommandLine` recognition rule exactly: once a space is typed
 *   after the command name, this stops matching and the dropdown closes on
 *   its own, letting `/plan on`-style argument text fall through as plain
 *   typing).
 * - `'mention'` — the LAST `@path` run in the buffer (via the same
 *   `AT_COMMAND_PATH_REGEX_SOURCE` `highlight.ts`/`at-mention-processor.ts`
 *   already use), and only when that run's end is the end of the buffer
 *   (i.e. it's the active, still-being-typed mention, not an earlier one
 *   the user has moved past).
 */

import { AT_COMMAND_PATH_REGEX_SOURCE } from '../at-mentions/at-mention-processor.js';

export interface AutocompleteRange {
  /** Index (inclusive) in `value` where the trigger character (`/` or `@`) starts. */
  start: number;
  /** Index (exclusive) — always `value.length` today, since the caret is always at the end. */
  end: number;
}

export type AutocompleteTarget =
  | {
      kind: 'slash';
      range: AutocompleteRange;
      /** Typed command name so far, lowercased comparison is the caller's job — this is the raw typed text. */
      query: string;
    }
  | {
      kind: 'mention';
      range: AutocompleteRange;
      /** Full typed path so far (no leading `@`), e.g. `"src/cli"`. */
      query: string;
      /** Directory portion to list, e.g. `"src"` for `"src/cli"`, or `""` for a bare `"cli"` (list `cwd`). */
      dirPart: string;
      /** Filename/dirname prefix to filter that listing by, e.g. `"cli"`. */
      segmentPrefix: string;
    };

function splitMentionPath(pathText: string): {
  dirPart: string;
  segmentPrefix: string;
} {
  const lastSlash = pathText.lastIndexOf('/');
  if (lastSlash === -1) return { dirPart: '', segmentPrefix: pathText };
  return {
    dirPart: pathText.slice(0, lastSlash),
    segmentPrefix: pathText.slice(lastSlash + 1),
  };
}

/**
 * Derives the active autocomplete target (if any) purely from the current
 * buffer. Returns `undefined` when neither trigger applies — the caller
 * should render no dropdown in that case.
 */
export function extractAutocompleteTarget(
  value: string,
): AutocompleteTarget | undefined {
  const slashMatch = /^\/(\S*)$/.exec(value);
  if (slashMatch) {
    return {
      kind: 'slash',
      range: { start: 0, end: value.length },
      query: slashMatch[1] ?? '',
    };
  }

  const mentionRegex = new RegExp(
    `(?<!\\\\)@${AT_COMMAND_PATH_REGEX_SOURCE}`,
    'g',
  );
  let lastMatch: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(value)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return undefined;

  const matchEnd = lastMatch.index + lastMatch[0].length;
  if (matchEnd !== value.length) return undefined; // not the active (trailing) mention

  const pathText = lastMatch[0].slice(1); // strip leading '@'
  const { dirPart, segmentPrefix } = splitMentionPath(pathText);
  return {
    kind: 'mention',
    range: { start: lastMatch.index, end: value.length },
    query: pathText,
    dirPart,
    segmentPrefix,
  };
}

/** The minimal shape `filterCommandSuggestions` reads — `commands/types.ts`'s real `SlashCommand` satisfies this structurally with no import needed, keeping this module dependency-free. */
export interface CommandLike {
  name: string;
  altNames?: readonly string[];
  description: string;
}

export interface AutocompleteSuggestion {
  /** Text inserted into the buffer when this suggestion is accepted (does NOT include the trigger char). */
  insertText: string;
  /** What the dropdown displays for this row. */
  label: string;
}

/** Case-insensitive prefix match against a command's name or any alt name, preserving registration order (the same order `/help` lists commands in). */
export function filterCommandSuggestions(
  commands: readonly CommandLike[],
  query: string,
): AutocompleteSuggestion[] {
  const q = query.toLowerCase();
  return commands
    .filter(
      (command) =>
        command.name.toLowerCase().startsWith(q) ||
        (command.altNames ?? []).some((alt) => alt.toLowerCase().startsWith(q)),
    )
    .map((command) => ({
      insertText: command.name,
      label: `/${command.name} — ${command.description}`,
    }));
}

/**
 * Case-sensitive prefix match against one already-fetched directory listing
 * (mirrors real shell tab-completion, and matches the real filesystem's own
 * case sensitivity on the platforms Deus targets). `entries` are expected to
 * already carry a trailing `/` for directories — see `AppContainer.tsx`'s
 * real `listMentionDirectory` adapter — so this function stays pure with no
 * `fs.stat` of its own.
 */
export function filterMentionSuggestions(
  entries: readonly string[],
  segmentPrefix: string,
): AutocompleteSuggestion[] {
  return entries
    .filter((entry) => entry.startsWith(segmentPrefix))
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => ({ insertText: entry, label: entry }));
}

/**
 * Applies an accepted suggestion to `value`, replacing only the active
 * target's range — everything before it (e.g. `"review "` in
 * `"review @src/cli"`) is preserved untouched. For a mention, re-joins the
 * target's own `dirPart` back onto the accepted entry (which is scoped to
 * just that directory's contents) so the result is the full `@path` again;
 * a directory suggestion's own trailing `/` (already present in
 * `suggestion.insertText`) is carried straight through, letting the caller
 * keep typing deeper into that directory immediately.
 */
export function applyAutocompleteAcceptance(
  value: string,
  target: AutocompleteTarget,
  suggestion: AutocompleteSuggestion,
): string {
  const prefix = value.slice(0, target.range.start);
  if (target.kind === 'slash') {
    return `${prefix}/${suggestion.insertText}`;
  }
  const dirPrefix = target.dirPart === '' ? '' : `${target.dirPart}/`;
  return `${prefix}@${dirPrefix}${suggestion.insertText}`;
}

/** Stable key identifying "what this target's suggestion list depends on" — used by `Composer.tsx` to know when to reset the selected index / re-fetch a directory listing. */
export function autocompleteTargetKey(
  target: AutocompleteTarget | undefined,
): string | undefined {
  if (!target) return undefined;
  return target.kind === 'slash'
    ? `slash:${target.query}`
    : `mention:${target.dirPart}:${target.segmentPrefix}`;
}
