/**
 * Adapted from google-gemini/gemini-cli's
 * packages/cli/src/ui/components/shared/MaxSizedBox.tsx (Apache-2.0). Core
 * truncation math (`contentHeight`/`ResizeObserver`-driven hidden-lines
 * computation, `overflowDirection`, `additionalHiddenLinesCount`) is kept
 * 1:1 — this is `CodeColorizer.tsx`'s height-constrained rendering path
 * (`availableHeight` provided, e.g. inside a tool-call preview box).
 *
 * Two dependencies dropped, both because nothing in Deus's tui-v2 build so
 * far (build-sequence steps 1-4) has a caller or equivalent for them yet:
 * - `useOverflowActions`/`OverflowContext` (a global registry Gemini uses
 *   elsewhere to show a "N boxes have hidden content" summary hint) has no
 *   Deus equivalent and no consumer in this repo yet. Dropped rather than
 *   built speculatively (per this repo's "don't solve problems that don't
 *   exist yet" rule) -- add it back, wired to a real Deus context, if/when
 *   a later step needs the aggregate hint.
 * - `Command.SHOW_MORE_LINES`/`formatCommand` (Gemini's keybinding-registry
 *   lookup for the hint text's key name) has no Deus keybinding system yet
 *   either. The truncation hint below states line counts only, without a
 *   parenthetical key hint that would reference a shortcut that doesn't
 *   exist yet -- avoids fabricating a fake keybinding. Restore the key
 *   hint once a real "show more" binding exists.
 *
 * One adaptation forced by removing gemini-cli-core / Gemini's own
 * `semantic-colors.js` module (neither exists in Deus): the truncation
 * hint's color now reads `themeManager.getSemanticColors().text.secondary`
 * from this repo's real ported theme-manager
 * (`src/cli/tui-v2/themes/theme-manager.ts`, build-sequence step 3) instead
 * of Gemini's `theme.text.secondary` import -- same semantic token, real
 * Deus source.
 *
 * See /Users/liam10play/.claude/plans/deus-tui-gemini-fork.md build-sequence
 * step 4.
 */

import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, Text, ResizeObserver, type DOMElement } from 'ink';
import { themeManager } from '../../themes/theme-manager.js';
import { isNarrowWidth } from '../../utils/isNarrowWidth.js';

/**
 * Minimum height for the MaxSizedBox component.
 * This ensures there is room for at least one line of content as well as the
 * message that content was truncated.
 */
export const MINIMUM_MAX_HEIGHT = 2;

export interface MaxSizedBoxProps {
  children?: React.ReactNode;
  maxWidth?: number;
  maxHeight?: number;
  overflowDirection?: 'top' | 'bottom';
  additionalHiddenLinesCount?: number;
  paddingX?: number;
}

/**
 * A React component that constrains the size of its children and provides
 * content-aware truncation when the content exceeds the specified `maxHeight`.
 */
export const MaxSizedBox: React.FC<MaxSizedBoxProps> = ({
  children,
  maxWidth,
  maxHeight,
  overflowDirection = 'top',
  additionalHiddenLinesCount = 0,
  paddingX = 0,
}) => {
  const id = useId();
  void id; // retained for parity with the donor; no OverflowContext consumer yet.
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  const [contentHeight, setContentHeight] = useState(0);

  const onRefChange = useCallback(
    (node: DOMElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (node && maxHeight !== undefined) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            setContentHeight(Math.round(entry.contentRect.height));
          }
        });
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [maxHeight],
  );

  const effectiveMaxHeight =
    maxHeight !== undefined
      ? Math.max(Math.round(maxHeight), MINIMUM_MAX_HEIGHT)
      : undefined;

  const isOverflowing =
    (effectiveMaxHeight !== undefined && contentHeight > effectiveMaxHeight) ||
    additionalHiddenLinesCount > 0;

  // If we're overflowing, we need to hide at least 1 line for the message.
  const visibleContentHeight =
    isOverflowing && effectiveMaxHeight !== undefined
      ? effectiveMaxHeight - 1
      : effectiveMaxHeight;

  const hiddenLinesCount =
    visibleContentHeight !== undefined
      ? Math.max(0, contentHeight - visibleContentHeight)
      : 0;

  const totalHiddenLines = hiddenLinesCount + additionalHiddenLinesCount;

  const isNarrow = maxWidth !== undefined && isNarrowWidth(maxWidth);
  const secondaryColor = themeManager.getSemanticColors().text.secondary;

  if (effectiveMaxHeight === undefined && totalHiddenLines === 0) {
    return (
      <Box flexDirection="column" width={maxWidth}>
        {children}
      </Box>
    );
  }

  const offset =
    hiddenLinesCount > 0 && overflowDirection === 'top' ? -hiddenLinesCount : 0;

  return (
    <Box
      flexDirection="column"
      width={maxWidth}
      maxHeight={effectiveMaxHeight}
      flexShrink={0}
    >
      {totalHiddenLines > 0 && overflowDirection === 'top' && (
        <Box paddingX={paddingX}>
          <Text color={secondaryColor} wrap="truncate">
            {isNarrow
              ? `... ${totalHiddenLines} hidden ...`
              : `... first ${totalHiddenLines} line${totalHiddenLines === 1 ? '' : 's'} hidden ...`}
          </Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        overflow="hidden"
        flexGrow={0}
        maxHeight={isOverflowing ? visibleContentHeight : undefined}
      >
        <Box
          flexDirection="column"
          ref={onRefChange}
          flexShrink={0}
          marginTop={offset}
        >
          {children}
        </Box>
      </Box>
      {totalHiddenLines > 0 && overflowDirection === 'bottom' && (
        <Box paddingX={paddingX}>
          <Text color={secondaryColor} wrap="truncate">
            {isNarrow
              ? `... ${totalHiddenLines} hidden ...`
              : `... last ${totalHiddenLines} line${totalHiddenLines === 1 ? '' : 's'} hidden ...`}
          </Text>
        </Box>
      )}
    </Box>
  );
};
