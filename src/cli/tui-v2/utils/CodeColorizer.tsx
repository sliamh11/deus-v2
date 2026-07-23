/**
 * Adapted from google-gemini/gemini-cli's
 * packages/cli/src/ui/utils/CodeColorizer.tsx (Apache-2.0). This is the
 * real "highlight.js-based syntax highlighting" component named by
 * build-sequence step 4 (`~/.claude/plans/deus-tui-gemini-fork.md`):
 * `lowlight` wraps `highlight.js` to turn a code string into a HAST tree,
 * which `renderHastNode` walks to produce Ink `<Text color=...>` elements
 * from the active theme's `getInkColor(hljsClass)` map. That core
 * algorithm (`renderHastNode`, `highlightAndRenderLine`, `colorizeLine`,
 * `colorizeCode`'s line-numbering / height-constrained / error-fallback
 * logic) is kept 1:1.
 *
 * Three adaptations, all forced by dependencies this plan's architecture
 * deliberately does not carry over (see the plan's "Decision" section:
 * Deus's client never depends on `@google/gemini-cli-core`, and design
 * decision #2 keeps `tuiReduce` as the single source of truth rather than
 * porting Gemini's `LoadedSettings` layer):
 *
 * 1. `debugLogger` (from `@google/gemini-cli-core`) becomes an injectable
 *    `onError` callback on `ColorizeCodeOptions`, defaulting to a no-op --
 *    the exact same pattern build-sequence step 3's `theme-manager.ts`
 *    independently already established for its own `debugLogger.warn`
 *    call (see that file's header), kept consistent here. `src/cli/tui/`
 *    has zero existing usage of this repo's pino `logger`
 *    (`src/logger.ts`) inside any TUI-subtree file -- Ink owns the
 *    terminal in raw/alt-screen mode, and an unrelated stdout-writing
 *    logger mid-render is a real corruption risk. Wiring `onError`
 *    somewhere real (a status banner, etc.) is left to whichever later
 *    step assembles the app shell.
 * 2. `LoadedSettings` (Gemini's own settings system, from
 *    `../../config/settings.js`) has no Deus equivalent and isn't part of
 *    this plan's design. `settings.merged.ui.showLineNumbers` and
 *    `settings.merged.ui.useAlternateBuffer` become plain
 *    `ColorizeCodeOptions` fields (`hideLineNumbers`, `useAlternateBuffer`)
 *    instead -- same two knobs, no settings-object indirection.
 * 3. Import paths adjusted for this repo's layout; `../themes/theme-manager.js`
 *    and `../themes/theme.js` resolve to build-sequence step 3's real,
 *    already-ported theme system (same relative depth as the donor, since
 *    `utils/` and `themes/` are siblings here too). `../components/shared/
 *    MaxSizedBox.js` resolves to this step's own adapted port (see that
 *    file's header for its own two dropped dependencies).
 *
 * See LIA-473's plan build-sequence
 * step 4.
 */

import React from 'react';
import { Text, Box } from 'ink';
import { common, createLowlight } from 'lowlight';
import type {
  Root,
  Element,
  Text as HastText,
  ElementContent,
  RootContent,
} from 'hast';
import stripAnsi from 'strip-ansi';
import { themeManager } from '../themes/theme-manager.js';
import type { Theme } from '../themes/theme.js';
import { MaxSizedBox, MINIMUM_MAX_HEIGHT } from '../components/shared/MaxSizedBox.js';

// Configure theming and parsing utilities.
const lowlight = createLowlight(common);

function renderHastNode(
  node: Root | Element | HastText | RootContent,
  theme: Theme,
  inheritedColor: string | undefined,
): React.ReactNode {
  if (node.type === 'text') {
    // Use the color passed down from parent element, or the theme's default.
    const color = inheritedColor || theme.defaultColor;
    return <Text color={color}>{node.value}</Text>;
  }

  // Handle Element Nodes: Determine color and pass it down, don't wrap
  if (node.type === 'element') {
    const nodeClasses: string[] =
      (node.properties?.['className'] as string[]) || [];
    let elementColor: string | undefined = undefined;

    // Find color defined specifically for this element's class
    for (let i = nodeClasses.length - 1; i >= 0; i--) {
      const color = theme.getInkColor(nodeClasses[i]);
      if (color) {
        elementColor = color;
        break;
      }
    }

    // Determine the color to pass down: Use this element's specific color
    // if found; otherwise, continue passing down the already inherited color.
    const colorToPassDown = elementColor || inheritedColor;

    // Recursively render children, passing the determined color down
    const children = node.children?.map(
      (child: ElementContent, index: number) => (
        <React.Fragment key={index}>
          {renderHastNode(child, theme, colorToPassDown)}
        </React.Fragment>
      ),
    );

    // Element nodes now only group children; color is applied by Text nodes.
    return <React.Fragment>{children}</React.Fragment>;
  }

  // Handle Root Node: Start recursion with initially inherited color
  if (node.type === 'root') {
    // Check if children array is empty - this happens when lowlight can't
    // detect language -- fall back to plain text
    if (!node.children || node.children.length === 0) {
      return null;
    }

    return node.children?.map((child: RootContent, index: number) => (
      <React.Fragment key={index}>
        {renderHastNode(child, theme, inheritedColor)}
      </React.Fragment>
    ));
  }

  // Handle unknown or unsupported node types
  return null;
}

function highlightAndRenderLine(
  line: string,
  language: string | null,
  theme: Theme,
): React.ReactNode {
  try {
    const strippedLine = stripAnsi(line);
    const getHighlightedLine = () =>
      !language || !lowlight.registered(language)
        ? lowlight.highlightAuto(strippedLine)
        : lowlight.highlight(language, strippedLine);

    const renderedNode = renderHastNode(getHighlightedLine(), theme, undefined);

    return renderedNode !== null ? renderedNode : strippedLine;
  } catch {
    return stripAnsi(line);
  }
}

export function colorizeLine(
  line: string,
  language: string | null,
  theme?: Theme,
  disableColor = false,
): React.ReactNode {
  if (disableColor) {
    return <Text>{line}</Text>;
  }
  const activeTheme = theme || themeManager.getActiveTheme();
  return highlightAndRenderLine(line, language, activeTheme);
}

export interface ColorizeCodeOptions {
  code: string;
  language?: string | null;
  availableHeight?: number;
  maxWidth: number;
  theme?: Theme | null;
  /** Force line numbers off regardless of caller preference. Default false (shown). */
  hideLineNumbers?: boolean;
  /**
   * Whether the surrounding UI is rendering to Ink's alternate screen
   * buffer. When false (or when `availableHeight` is supplied), height
   * constraints are enforced via `MaxSizedBox`'s hidden-lines truncation
   * even inside a scrollable/non-alternate-buffer layout. Default true.
   */
  useAlternateBuffer?: boolean;
  disableColor?: boolean;
  returnLines?: boolean;
  paddingX?: number;
  /** Called instead of throwing when highlighting fails. Default: no-op. */
  onError?: (message: string, error: unknown) => void;
}

/**
 * Renders syntax-highlighted code for Ink applications using a selected theme.
 *
 * @param options The options for colorizing the code.
 * @returns A React.ReactNode containing Ink <Text> elements for the highlighted code.
 */
export function colorizeCode(
  options: ColorizeCodeOptions & { returnLines: true },
): React.ReactNode[];
export function colorizeCode(
  options: ColorizeCodeOptions & { returnLines?: false },
): React.ReactNode;
export function colorizeCode({
  code,
  language = null,
  availableHeight,
  maxWidth,
  theme = null,
  hideLineNumbers = false,
  useAlternateBuffer = true,
  disableColor = false,
  returnLines = false,
  paddingX = 0,
  onError = () => {},
}: ColorizeCodeOptions): React.ReactNode | React.ReactNode[] {
  const codeToHighlight = code.replace(/\n$/, '');
  const activeTheme = theme || themeManager.getActiveTheme();
  const showLineNumbers = !hideLineNumbers;

  // We force MaxSizedBox if availableHeight is provided, even if alternate
  // buffer is enabled, because this might be rendered in a constrained UI
  // box (like tool confirmation).
  const useMaxSizedBox =
    (!useAlternateBuffer || availableHeight !== undefined) && !returnLines;

  let hiddenLinesCount = 0;
  let finalLines = codeToHighlight.split(/\r?\n/);

  try {
    // Optimization to avoid highlighting lines that cannot possibly be displayed.
    if (availableHeight !== undefined && useMaxSizedBox) {
      availableHeight = Math.max(availableHeight, MINIMUM_MAX_HEIGHT);
      if (finalLines.length > availableHeight) {
        const sliceIndex = finalLines.length - availableHeight;
        hiddenLinesCount = sliceIndex;
        finalLines = finalLines.slice(sliceIndex);
      }
    }

    const padWidth = String(finalLines.length + hiddenLinesCount).length;

    const renderedLines = finalLines.map((line, index) => {
      const contentToRender = disableColor
        ? line
        : highlightAndRenderLine(line, language, activeTheme);

      return (
        <Box key={index} minHeight={1}>
          {showLineNumbers && (
            <Box
              minWidth={padWidth + 1}
              flexShrink={0}
              paddingRight={1}
              alignItems="flex-start"
              justifyContent="flex-end"
            >
              <Text color={disableColor ? undefined : activeTheme.colors.Gray}>
                {`${index + 1 + hiddenLinesCount}`}
              </Text>
            </Box>
          )}
          <Text
            color={disableColor ? undefined : activeTheme.defaultColor}
            wrap="wrap"
          >
            {contentToRender}
          </Text>
        </Box>
      );
    });

    if (returnLines) {
      return renderedLines;
    }

    if (useMaxSizedBox) {
      return (
        <MaxSizedBox
          paddingX={paddingX}
          maxHeight={availableHeight}
          maxWidth={maxWidth}
          additionalHiddenLinesCount={hiddenLinesCount}
          overflowDirection="top"
        >
          {renderedLines}
        </MaxSizedBox>
      );
    }

    return (
      <Box flexDirection="column" width={maxWidth}>
        {renderedLines}
      </Box>
    );
  } catch (error) {
    onError(
      `[colorizeCode] Error highlighting code for language "${language}":`,
      error,
    );
    // Fall back to plain text with default color on error
    const padWidth = String(finalLines.length + hiddenLinesCount).length;
    const fallbackLines = finalLines.map((line, index) => (
      <Box key={index} minHeight={1}>
        {showLineNumbers && (
          <Box
            minWidth={padWidth + 1}
            flexShrink={0}
            paddingRight={1}
            alignItems="flex-start"
            justifyContent="flex-end"
          >
            <Text color={disableColor ? undefined : activeTheme.defaultColor}>
              {`${index + 1 + hiddenLinesCount}`}
            </Text>
          </Box>
        )}
        <Text color={disableColor ? undefined : activeTheme.colors.Gray}>
          {stripAnsi(line)}
        </Text>
      </Box>
    ));

    if (returnLines) {
      return fallbackLines;
    }

    if (useMaxSizedBox) {
      return (
        <MaxSizedBox
          paddingX={paddingX}
          maxHeight={availableHeight}
          maxWidth={maxWidth}
          additionalHiddenLinesCount={hiddenLinesCount}
          overflowDirection="top"
        >
          {fallbackLines}
        </MaxSizedBox>
      );
    }

    return (
      <Box flexDirection="column" width={maxWidth}>
        {fallbackLines}
      </Box>
    );
  }
}
