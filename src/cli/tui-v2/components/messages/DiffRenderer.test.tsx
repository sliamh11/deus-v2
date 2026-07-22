/**
 * Component tests for the near-verbatim `DiffRenderer.tsx` port
 * (build-sequence step 7, see
 * `~/.claude/plans/deus-tui-gemini-fork.md`), via `ink-testing-library`'s
 * `render()`/`lastFrame()` — the same harness `src/cli/tui/deus-tui-app.test.tsx`
 * uses, applied directly to a single component the way this repo's own
 * `CodeColorizer.test.tsx` (build-sequence step 4) already established as
 * the pattern for pure-presentational `tui-v2` components (no fake
 * transport/app harness needed — `DiffRenderer` takes no app state).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import { DiffRenderer, parseDiffWithLineNumbers, isNewFile } from './DiffRenderer.js';

afterEach(() => {
  cleanup();
});

const SIMPLE_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,3 +1,3 @@',
  ' line one',
  '-line two old',
  '+line two new',
  ' line three',
].join('\n');

const NEW_FILE_DIFF = [
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1,2 @@',
  '+const x = 1;',
  '+const y = 2;',
].join('\n');

describe('parseDiffWithLineNumbers', () => {
  it('classifies added, removed, and context lines with correct line numbers', () => {
    const parsed = parseDiffWithLineNumbers(SIMPLE_DIFF);
    const added = parsed.find((l) => l.type === 'add');
    const removed = parsed.find((l) => l.type === 'del');
    const context = parsed.filter((l) => l.type === 'context');

    expect(added).toMatchObject({ content: 'line two new', newLine: 2 });
    expect(removed).toMatchObject({ content: 'line two old', oldLine: 2 });
    expect(context).toHaveLength(2);
  });
});

describe('isNewFile', () => {
  it('detects an all-added-lines diff as a new file', () => {
    const parsed = parseDiffWithLineNumbers(NEW_FILE_DIFF);
    expect(isNewFile(parsed)).toBe(true);
  });

  it('does not classify a mixed add/remove diff as a new file', () => {
    const parsed = parseDiffWithLineNumbers(SIMPLE_DIFF);
    expect(isNewFile(parsed)).toBe(false);
  });
});

describe('DiffRenderer', () => {
  it('renders "No diff content." for empty/undefined content', () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent="" terminalWidth={80} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('No diff content.');
  });

  it('renders both changed lines of a mixed diff with +/- gutters', () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={SIMPLE_DIFF} terminalWidth={80} filename="foo.ts" />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('line two old');
    expect(frame).toContain('line two new');
    expect(frame).toMatch(/-\s*line two old/);
    expect(frame).toMatch(/\+\s*line two new/);
  });

  it('renders a new-file diff via the colorizeCode path (no diff gutters)', () => {
    const { lastFrame } = render(
      <DiffRenderer diffContent={NEW_FILE_DIFF} terminalWidth={80} filename="new.ts" />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('const x = 1;');
    expect(frame).toContain('const y = 2;');
  });

  it('respects disableColor by emitting no ANSI color escapes', () => {
    const { lastFrame } = render(
      <DiffRenderer
        diffContent={SIMPLE_DIFF}
        terminalWidth={80}
        filename="foo.ts"
        disableColor
      />,
    );
    const frame = lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[\d+(;\d+)*m/.test(frame)).toBe(false);
  });
});
