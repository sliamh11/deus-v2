/**
 * Ported near-verbatim from google-gemini/gemini-cli's
 * packages/cli/src/ui/components/messages/DiffRenderer.tsx (Apache-2.0),
 * fetched and read directly at build-sequence step 7
 * (`~/.claude/plans/deus-tui-gemini-fork.md`). Per the plan, this file is
 * "pure diff-rendering logic, minimal Gemini-core coupling" — confirmed by
 * reading the real donor file: it imports nothing from
 * `@google/gemini-cli-core`. `parseDiffWithLineNumbers`, `isNewFile`,
 * `renderDiffLines`, and `getLanguageFromExtension` are kept 1:1, byte-for-
 * byte logic (only import paths changed).
 *
 * Four adaptations, all forced by dependencies this plan's architecture
 * deliberately does not carry over (same class of adaptation
 * `CodeColorizer.tsx`/`MaxSizedBox.tsx` already made in build-sequence steps
 * 3-4 — see those files' headers):
 * 1. `useSettings()`/`SettingsContext` (Gemini's `LoadedSettings` layer) has
 *    no Deus equivalent (design decision #2 keeps `tuiReduce` as the single
 *    source of truth, not a settings-context tree) — dropped, matching
 *    `CodeColorizer.tsx`'s own `colorizeCode` signature, which already has
 *    no `settings` parameter for the same reason. `colorizeCode` is called
 *    below without a `settings` argument accordingly.
 * 2. `theme as semanticTheme` from `../../semantic-colors.js` (a Gemini-only
 *    module) becomes `themeManager.getSemanticColors()` from this repo's
 *    real ported theme system (`themes/theme-manager.ts`) — same semantic
 *    token names (`text.secondary`, `status.warning/success/error`,
 *    `background.diff.added/removed`), real Deus source.
 * 3. `getFileExtension` (from Gemini's `../../utils/fileUtils.js`, a file
 *    with no Deus port and no other caller yet) is reduced to the one-line
 *    extension extraction this file actually needs, defined locally below
 *    rather than porting the whole donor module speculatively for a single
 *    caller (per this repo's "don't solve problems that don't exist yet"
 *    rule).
 * 4. `useIsScreenReaderEnabled` from `ink` is real and stock in
 *    `@jrichman/ink@6.6.9` (confirmed: `node_modules/ink/build/index.d.ts`
 *    exports it directly) — kept unchanged, no adaptation needed.
 *
 * See /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md build-sequence
 * step 7.
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';

import { colorizeCode, colorizeLine } from '../../utils/CodeColorizer.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { themeManager } from '../../themes/theme-manager.js';
import type { Theme } from '../../themes/theme.js';

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

export function parseDiffWithLineNumbers(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      // We need to adjust the starting point because the first line number applies to the *first* actual line change/context,
      // but we increment *before* pushing that line. So decrement here.
      currentOldLine--;
      currentNewLine--;
      continue;
    }
    if (!inHunk) {
      // Skip standard Git header lines more robustly
      if (line.startsWith('--- ')) {
        continue;
      }
      // If it's not a hunk or header, skip (or handle as 'other' if needed)
      continue;
    }
    if (line.startsWith('+')) {
      currentNewLine++; // Increment before pushing
      result.push({
        type: 'add',
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('-')) {
      currentOldLine++; // Increment before pushing
      result.push({
        type: 'del',
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(' ')) {
      currentOldLine++; // Increment before pushing
      currentNewLine++;
      result.push({
        type: 'context',
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('\\')) {
      // Handle "\ No newline at end of file"
      result.push({ type: 'other', content: line });
    }
  }
  return result;
}

interface DiffRendererProps {
  diffContent: string;
  filename?: string;
  tabWidth?: number;
  availableTerminalHeight?: number;
  terminalWidth: number;
  theme?: Theme;
  disableColor?: boolean;
  paddingX?: number;
}

const DEFAULT_TAB_WIDTH = 4; // Spaces per tab for normalization

export const DiffRenderer: React.FC<DiffRendererProps> = ({
  diffContent,
  filename,
  tabWidth = DEFAULT_TAB_WIDTH,
  availableTerminalHeight,
  terminalWidth,
  theme,
  disableColor = false,
  paddingX = 0,
}) => {
  const semanticColors = themeManager.getSemanticColors();
  const screenReaderEnabled = useIsScreenReaderEnabled();

  const parsedLines = useMemo(() => {
    if (!diffContent || typeof diffContent !== 'string') {
      return [];
    }
    return parseDiffWithLineNumbers(diffContent);
  }, [diffContent]);

  const isNewFileResult = useMemo(() => isNewFile(parsedLines), [parsedLines]);

  const renderedOutput = useMemo(() => {
    if (!diffContent || typeof diffContent !== 'string') {
      return <Text color={semanticColors.status.warning}>No diff content.</Text>;
    }

    if (parsedLines.length === 0) {
      return (
        <Box padding={1}>
          <Text dimColor>No changes detected.</Text>
        </Box>
      );
    }
    if (screenReaderEnabled) {
      return (
        <Box flexDirection="column">
          {parsedLines.map((line, index) => (
            <Text key={index}>
              {line.type}: {line.content}
            </Text>
          ))}
        </Box>
      );
    }

    if (isNewFileResult) {
      // Extract only the added lines' content
      const addedContent = parsedLines
        .filter((line) => line.type === 'add')
        .map((line) => line.content)
        .join('\n');
      // Attempt to infer language from filename, default to plain text if no filename
      const fileExtension = getFileExtension(filename);
      const language = fileExtension
        ? getLanguageFromExtension(fileExtension)
        : null;
      return colorizeCode({
        code: addedContent,
        language,
        availableHeight: availableTerminalHeight,
        maxWidth: terminalWidth,
        theme,
        disableColor,
        paddingX,
      });
    } else {
      const key = filename ? `diff-box-${filename}` : undefined;

      return (
        <MaxSizedBox
          paddingX={paddingX}
          maxHeight={availableTerminalHeight}
          maxWidth={terminalWidth}
          key={key}
        >
          {renderDiffLines({
            parsedLines,
            filename,
            tabWidth,
            terminalWidth,
            disableColor,
          })}
        </MaxSizedBox>
      );
    }
  }, [
    diffContent,
    parsedLines,
    screenReaderEnabled,
    isNewFileResult,
    filename,
    availableTerminalHeight,
    terminalWidth,
    theme,
    tabWidth,
    disableColor,
    paddingX,
    semanticColors,
  ]);

  return renderedOutput;
};

export const isNewFile = (parsedLines: DiffLine[]): boolean => {
  if (parsedLines.length === 0) return false;
  return parsedLines.every(
    (line) =>
      line.type === 'add' ||
      line.type === 'hunk' ||
      line.type === 'other' ||
      line.content.startsWith('diff --git') ||
      line.content.startsWith('new file mode'),
  );
};

export interface RenderDiffLinesOptions {
  parsedLines: DiffLine[];
  filename?: string;
  tabWidth?: number;
  terminalWidth: number;
  disableColor?: boolean;
}

export const renderDiffLines = ({
  parsedLines,
  tabWidth = DEFAULT_TAB_WIDTH,
  terminalWidth,
  disableColor = false,
  filename,
}: RenderDiffLinesOptions): React.ReactNode[] => {
  const semanticColors = themeManager.getSemanticColors();

  // 1. Normalize whitespace (replace tabs with spaces) *before* further processing
  const normalizedLines = parsedLines.map((line) => ({
    ...line,
    content: line.content.replace(/\t/g, ' '.repeat(tabWidth)),
  }));

  // Filter out non-displayable lines (hunks, potentially 'other') using the normalized list
  const displayableLines = normalizedLines.filter(
    (l) => l.type !== 'hunk' && l.type !== 'other',
  );

  if (displayableLines.length === 0) {
    return [
      <Box key="no-changes" padding={1}>
        <Text dimColor>No changes detected.</Text>
      </Box>,
    ];
  }

  const maxLineNumber = Math.max(
    0,
    ...displayableLines.map((l) => l.oldLine ?? 0),
    ...displayableLines.map((l) => l.newLine ?? 0),
  );
  const gutterWidth = Math.max(1, maxLineNumber.toString().length);

  const fileExtension = getFileExtension(filename);
  const language = fileExtension
    ? getLanguageFromExtension(fileExtension)
    : null;

  // Calculate the minimum indentation across all displayable lines
  let baseIndentation = Infinity; // Start high to find the minimum
  for (const line of displayableLines) {
    // Only consider lines with actual content for indentation calculation
    if (line.content.trim() === '') continue;

    const firstCharIndex = line.content.search(/\S/); // Find index of first non-whitespace char
    const currentIndent = firstCharIndex === -1 ? 0 : firstCharIndex; // Indent is 0 if no non-whitespace found
    baseIndentation = Math.min(baseIndentation, currentIndent);
  }
  // If baseIndentation remained Infinity (e.g., no displayable lines with content), default to 0
  if (!isFinite(baseIndentation)) {
    baseIndentation = 0;
  }

  let lastLineNumber: number | null = null;
  const MAX_CONTEXT_LINES_WITHOUT_GAP = 5;

  const content = displayableLines.reduce<React.ReactNode[]>(
    (acc, line, index) => {
      // Determine the relevant line number for gap calculation based on type
      let relevantLineNumberForGapCalc: number | null = null;
      if (line.type === 'add' || line.type === 'context') {
        relevantLineNumberForGapCalc = line.newLine ?? null;
      } else if (line.type === 'del') {
        // For deletions, the gap is typically in relation to the original file's line numbering
        relevantLineNumberForGapCalc = line.oldLine ?? null;
      }

      if (
        lastLineNumber !== null &&
        relevantLineNumberForGapCalc !== null &&
        relevantLineNumberForGapCalc >
          lastLineNumber + MAX_CONTEXT_LINES_WITHOUT_GAP + 1
      ) {
        acc.push(
          <Box key={`gap-${index}`}>
            <Box
              borderStyle="double"
              borderLeft={false}
              borderRight={false}
              borderBottom={false}
              width={terminalWidth}
              borderColor={semanticColors.text.secondary}
            ></Box>
          </Box>,
        );
      }

      const lineKey = `diff-line-${index}`;
      let gutterNumStr = '';
      let prefixSymbol = ' ';

      switch (line.type) {
        case 'add':
          gutterNumStr = (line.newLine ?? '').toString();
          prefixSymbol = '+';
          lastLineNumber = line.newLine ?? null;
          break;
        case 'del':
          gutterNumStr = (line.oldLine ?? '').toString();
          prefixSymbol = '-';
          // For deletions, update lastLineNumber based on oldLine if it's advancing.
          // This helps manage gaps correctly if there are multiple consecutive deletions
          // or if a deletion is followed by a context line far away in the original file.
          if (line.oldLine !== undefined) {
            lastLineNumber = line.oldLine;
          }
          break;
        case 'context':
          gutterNumStr = (line.newLine ?? '').toString();
          prefixSymbol = ' ';
          lastLineNumber = line.newLine ?? null;
          break;
        default:
          return acc;
      }

      const displayContent = line.content.substring(baseIndentation);

      const backgroundColor = disableColor
        ? undefined
        : line.type === 'add'
          ? semanticColors.background.diff.added
          : line.type === 'del'
            ? semanticColors.background.diff.removed
            : undefined;

      const gutterColor = disableColor
        ? undefined
        : semanticColors.text.secondary;

      const symbolColor = disableColor
        ? undefined
        : line.type === 'add'
          ? semanticColors.status.success
          : line.type === 'del'
            ? semanticColors.status.error
            : undefined;

      acc.push(
        <Box key={lineKey} flexDirection="row">
          <Box
            width={gutterWidth + 1}
            paddingRight={1}
            flexShrink={0}
            backgroundColor={backgroundColor}
            justifyContent="flex-end"
          >
            <Text color={gutterColor}>{gutterNumStr}</Text>
          </Box>
          {line.type === 'context' ? (
            <>
              <Text>{prefixSymbol} </Text>
              <Text wrap="wrap">
                {colorizeLine(
                  displayContent,
                  language,
                  undefined,
                  disableColor,
                )}
              </Text>
            </>
          ) : (
            <Text backgroundColor={backgroundColor} wrap="wrap">
              <Text color={symbolColor}>{prefixSymbol}</Text>{' '}
              {colorizeLine(displayContent, language, undefined, disableColor)}
            </Text>
          )}
        </Box>,
      );
      return acc;
    },
    [],
  );

  return content;
};

/**
 * One-line replacement for Gemini's `getFileExtension` (see header comment
 * #3) — the only behavior this file needs from that donor module.
 */
function getFileExtension(filename: string | undefined): string | null {
  if (!filename) return null;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) return null;
  return filename.slice(lastDot + 1).toLowerCase();
}

const getLanguageFromExtension = (extension: string): string | null => {
  const languageMap: { [key: string]: string } = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    json: 'json',
    css: 'css',
    html: 'html',
    sh: 'bash',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    txt: 'plaintext',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    rb: 'ruby',
  };
  return languageMap[extension] || null; // Return null if extension not found
};
