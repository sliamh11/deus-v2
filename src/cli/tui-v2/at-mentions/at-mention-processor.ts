/**
 * `@path` file mentions — ported from google-gemini/gemini-cli's
 * `packages/cli/src/ui/hooks/atCommandProcessor.ts` (Apache-2.0, fetched and
 * read directly — 794 lines; found via the GitHub contents API under
 * `packages/cli/src/ui/hooks/`, per this step's brief to locate the real
 * at-mention-processor-shaped file rather than inventing the parsing rules
 * from scratch).
 *
 * `AT_COMMAND_PATH_REGEX_SOURCE`, `parseAllAtCommands`, `escapeAtSymbols`,
 * and `unescapeLiteralAt` below are ported near-verbatim (only renamed
 * exports kept, comments trimmed) — these four are the one genuinely
 * portable slice of that file: pure string/regex parsing with zero
 * dependency on `@google/gemini-cli-core`. Everything else in the real file
 * (`categorizeAtCommands`'s agent-registry/resource-registry dispatch,
 * `resolveFilePaths`'s git/gemini-ignore + glob-tool fallback search,
 * `readMcpResources`, `readLocalFiles`'s `ReadManyFilesTool` invocation,
 * `handleAtCommand`'s orchestration) is built entirely on `Config`/
 * `ReadManyFilesTool`/agent registry/MCP resource registry — none of which
 * exist in Deus's architecture (per the plan's "Critical reconciled
 * finding": tool execution happens in Deus's daemon, not the TUI client).
 *
 * `resolveAtMentions` below is the new, Deus-scoped replacement for that
 * second half: given the parsed `@path` parts, it resolves each one against
 * `cwd` directly via injected `fs`-shaped deps (files are read and inlined;
 * directories get a one-level, non-recursive listing — there is no
 * client-side glob tool here to recurse with, unlike Gemini's `globTool`
 * fallback), building one reference-content block appended to the prompt
 * text sent to `submitTurn`. Missing/unreadable paths are collected as
 * errors and reported to the user rather than silently resolved away, but
 * never abort the whole submission — the rest of the message still sends.
 */

export const AT_COMMAND_PATH_REGEX_SOURCE =
  '(?:(?:"(?:[^"]*)")|(?:\\\\.|[^ \\t\\n\\r,;!?()\\[\\]{}.]|\\.(?!$|[ \\t\\n\\r])))+';

/** Escapes unescaped `@` symbols so they are not interpreted as `@path` mentions. */
export function escapeAtSymbols(text: string): string {
  return text.replace(/(?<!\\)@/g, '\\@');
}

/** Unescapes `\@` back to `@`, preserving `\\@` sequences — ported verbatim. */
export function unescapeLiteralAt(text: string): string {
  return text.replace(/\\@/g, (_match, offset: number, full: string) => {
    let backslashCount = 0;
    for (let i = offset - 1; i >= 0 && full[i] === '\\'; i--) {
      backslashCount++;
    }
    return backslashCount % 2 === 0 ? '@' : '\\@';
  });
}

export interface AtCommandPart {
  type: 'text' | 'atPath';
  content: string;
}

/**
 * Parses a query string into text/`atPath` segments. Ported verbatim from
 * the real `parseAllAtCommands` (minus its `escapePastedAtSymbols` param —
 * `tui-v2`'s composer has no paste-escaping pipeline for this step to hook
 * into yet, so that branch would be permanently dead code here; adding it
 * back is a one-line change if a future step needs it).
 */
export function parseAllAtCommands(query: string): AtCommandPart[] {
  const parts: AtCommandPart[] = [];
  let lastIndex = 0;

  const atCommandRegex = new RegExp(
    `(?<!\\\\)@${AT_COMMAND_PATH_REGEX_SOURCE}`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = atCommandRegex.exec(query)) !== null) {
    const matchIndex = match.index;
    const fullMatch = match[0];

    if (matchIndex > lastIndex) {
      parts.push({
        type: 'text',
        content: query.substring(lastIndex, matchIndex),
      });
    }

    parts.push({ type: 'atPath', content: '@' + fullMatch.substring(1) });
    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < query.length) {
    parts.push({ type: 'text', content: query.substring(lastIndex) });
  }

  return parts.filter(
    (part) => !(part.type === 'text' && part.content.trim() === ''),
  );
}

export interface AtMentionFsDeps {
  readFile: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (path: string) => Promise<string[]>;
  /** Joins/resolves `name` against `cwd`. Defaults to `node:path`'s `resolve`; injectable so tests don't depend on the real filesystem's path separator. */
  resolvePath: (cwd: string, name: string) => string;
}

export interface ResolvedAtMention {
  atPath: string;
  displayLabel: string;
  content: string;
}

export interface AtMentionResolution {
  /** Empty when no `@path` mentions were found, or all failed to resolve. */
  resolved: ResolvedAtMention[];
  /** One human-readable line per mention that could not be resolved. */
  errors: string[];
}

const MAX_FILE_BYTES = 262_144; // 256 KiB — inline text-file mentions only, never a huge blob.
const MAX_DIR_ENTRIES = 200;

async function resolveOnePath(
  atPath: string,
  cwd: string,
  deps: AtMentionFsDeps,
): Promise<ResolvedAtMention | { error: string }> {
  const name = atPath.substring(1);
  if (!name) return { error: `Empty @ mention: "${atPath}"` };

  const resolved = deps.resolvePath(cwd, name);
  let stats;
  try {
    stats = await deps.stat(resolved);
  } catch {
    return { error: `@${name}: not found` };
  }

  if (stats.isDirectory()) {
    let entries: string[];
    try {
      entries = await deps.readdir(resolved);
    } catch (error) {
      return {
        error: `@${name}: failed to list directory (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const shown = entries.slice(0, MAX_DIR_ENTRIES);
    const truncatedNote =
      entries.length > MAX_DIR_ENTRIES
        ? `\n… ${entries.length - MAX_DIR_ENTRIES} more entries not shown`
        : '';
    return {
      atPath,
      displayLabel: name,
      content: `[directory listing]\n${shown.join('\n')}${truncatedNote}`,
    };
  }

  let content: string;
  try {
    content = await deps.readFile(resolved);
  } catch (error) {
    return {
      error: `@${name}: failed to read file (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (content.length > MAX_FILE_BYTES) {
    content =
      content.slice(0, MAX_FILE_BYTES) +
      `\n… truncated (file exceeds ${MAX_FILE_BYTES} bytes)`;
  }
  return { atPath, displayLabel: name, content };
}

/**
 * Resolves every `@path` mention parsed out of `text` against `cwd`. Never
 * rejects: unresolved mentions are reported via `errors`, resolved ones via
 * `resolved` — `at-mention-processor.test.ts` exercises both a real
 * (deps-mocked) file and a missing path in the same call to prove neither
 * short-circuits the other.
 */
export async function resolveAtMentions(
  text: string,
  cwd: string,
  deps: AtMentionFsDeps,
): Promise<AtMentionResolution> {
  const atPaths = parseAllAtCommands(text)
    .filter((part) => part.type === 'atPath')
    .map((part) => part.content);

  const resolved: ResolvedAtMention[] = [];
  const errors: string[] = [];

  for (const atPath of atPaths) {
    const outcome = await resolveOnePath(atPath, cwd, deps);
    if ('error' in outcome) errors.push(outcome.error);
    else resolved.push(outcome);
  }

  return { resolved, errors };
}

/**
 * Builds the final prompt text sent to `submitTurn`: the user's original
 * text, unchanged, followed by one inlined reference block per resolved
 * mention (mirrors the real `handleAtCommand`'s "Content from @path:"
 * framing) — or the original text alone when there was nothing to resolve.
 */
export function appendResolvedMentions(
  originalText: string,
  resolution: AtMentionResolution,
): string {
  if (resolution.resolved.length === 0) return originalText;
  const blocks = resolution.resolved
    .map((r) => `\nContent from @${r.displayLabel}:\n${r.content}`)
    .join('\n');
  return `${originalText}\n${blocks}`;
}
