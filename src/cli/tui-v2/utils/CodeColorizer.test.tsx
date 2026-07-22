/**
 * Unit tests for the ported `colorizeCode`/`colorizeLine`
 * (`src/cli/tui-v2/utils/CodeColorizer.tsx`), adapted from
 * google-gemini/gemini-cli's own
 * `packages/cli/src/ui/utils/CodeColorizer.test.tsx` (Apache-2.0). Three of
 * the cases below (empty-line preservation, ANSI-escape-leak stripping,
 * `returnLines` returning one element per line) port that file's actual
 * assertions, adapted to this repo's real testing tools:
 * - `renderWithProviders`/`toMatchSvgSnapshot` (Gemini's own test-utils, not
 *   present in this repo) become `ink-testing-library`'s `render()`/
 *   `lastFrame()`, the same harness `src/cli/tui/deus-tui-app.test.tsx`
 *   already uses for this repo's TUI components.
 * - `LoadedSettings` (Gemini's settings object, dropped per
 *   `CodeColorizer.tsx`'s header) becomes plain `hideLineNumbers`/
 *   `useAlternateBuffer` options.
 * A fourth case (real highlight.js/lowlight color markup for a known
 * language) is new here, not in Gemini's own test file, added per the
 * build-sequence step 4 task brief's explicit ask ("a code block in a known
 * language renders with expected ANSI/color markup") -- it exercises the
 * actual `lowlight` -> `renderHastNode` -> Ink `<Text color>` pipeline
 * end-to-end against a real (not mocked) theme, since `colorizeCode`'s
 * default theme comes from the real, already-ported
 * `src/cli/tui-v2/themes/theme-manager.ts` (build-sequence step 3).
 *
 * See LIA-473's plan build-sequence
 * step 4.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import stripAnsi from 'strip-ansi';
import { colorizeCode, colorizeLine } from './CodeColorizer.js';

afterEach(() => {
  cleanup();
});

describe('colorizeCode', () => {
  it('preserves an empty line in the middle of a code block', () => {
    const code = 'line 1\n\nline 3';

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      hideLineNumbers: true,
      useAlternateBuffer: true,
    });

    const { lastFrame } = render(result as ReactElement);
    // If the empty middle line were dropped, this would collapse to
    // "line 1\nline 3" with no blank line between them. Strip the
    // highlighter's own per-token ANSI color codes first -- lastFrame()
    // includes them (confirmed by direct observation of the real theme
    // output below), and "line 1" would otherwise not appear as
    // contiguous text since "line " and "1" get separate color spans.
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/line 1\s*\n\s*\n\s*line 3/);
  });

  it('does not let raw ANSI escape codes from the source leak into the rendered output', () => {
    const code = 'line 1\n\x1b[41mline 2 with red background\x1b[0m\nline 3';

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      hideLineNumbers: true,
      useAlternateBuffer: true,
    });

    const { lastFrame } = render(result as ReactElement);
    const frame = lastFrame() ?? '';

    // The source's own raw ANSI escape sequence (`\x1b[41m`, a legacy
    // 16-color red background) must be stripped before highlighting
    // (highlightAndRenderLine calls stripAnsi first on the raw line) -- it
    // must not survive into the rendered frame as a literal escape byte.
    // The theme's own truecolor foreground codes (`\x1b[38;2;...m`) are
    // expected to be present -- this checks the SOURCE'S code specifically,
    // not the highlighter's own.
    // eslint-disable-next-line no-control-regex
    expect(frame).not.toMatch(/\x1b\[41m/);
    expect(stripAnsi(frame)).toContain('line 2 with red background');
  });

  it('returns one element per line when returnLines is true', () => {
    const code = 'line 1\nline 2\nline 3';

    const result = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      hideLineNumbers: true,
      returnLines: true,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('renders a known language with real lowlight/highlight.js color markup, not plain text', () => {
    const code = "function greet(name) {\n  return 'hi ' + name;\n}";

    const highlighted = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      hideLineNumbers: true,
      disableColor: false,
    });
    const plain = colorizeCode({
      code,
      language: 'javascript',
      maxWidth: 80,
      hideLineNumbers: true,
      disableColor: true,
    });

    const highlightedFrame = render(highlighted as ReactElement).lastFrame() ?? '';
    const plainFrame = render(plain as ReactElement).lastFrame() ?? '';

    // Both preserve the same text content (ANSI codes stripped before
    // comparing, since the highlighted frame's codes split "function" and
    // "greet(name)" into separate color spans)...
    expect(stripAnsi(highlightedFrame)).toContain('function greet(name)');
    expect(stripAnsi(plainFrame)).toContain('function greet(name)');
    // ...but only the highlighted render carries ANSI color escapes: the
    // disableColor path renders every line via a colorless <Text>, while
    // the highlighted path renders through lowlight -> renderHastNode,
    // which applies theme.getInkColor(...) per hljs token class. If
    // highlighting silently no-ops (e.g. the 'javascript' grammar fails to
    // register), the two frames would be byte-identical.
    // eslint-disable-next-line no-control-regex
    const hasAnsiColor = (s: string) => /\x1b\[\d+(;\d+)*m/.test(s);
    expect(hasAnsiColor(plainFrame)).toBe(false);
    expect(hasAnsiColor(highlightedFrame)).toBe(true);
    expect(highlightedFrame).not.toBe(plainFrame);
  });

  it('falls back to line numbers computed from content when hideLineNumbers is false', () => {
    const code = 'a\nb\nc';

    const result = colorizeCode({
      code,
      language: null,
      maxWidth: 80,
      hideLineNumbers: false,
    });

    const { lastFrame } = render(result as ReactElement);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/1.*a/);
    expect(frame).toMatch(/2.*b/);
    expect(frame).toMatch(/3.*c/);
  });
});

describe('colorizeLine', () => {
  it('renders plain text without highlighting when disableColor is true', () => {
    const { lastFrame } = render(
      colorizeLine('const x = 1;', 'javascript', undefined, true) as ReactElement,
    );
    expect(lastFrame()).toBe('const x = 1;');
  });

  it('falls back to plain stripped text for an unregistered/unknown language without throwing', () => {
    expect(() =>
      render(
        colorizeLine('some text', 'not-a-real-language', undefined, false) as ReactElement,
      ),
    ).not.toThrow();
  });
});
