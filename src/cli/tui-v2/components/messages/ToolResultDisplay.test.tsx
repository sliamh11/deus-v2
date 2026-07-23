/**
 * Component tests for the re-typed `ToolResultDisplay.tsx`
 * (build-sequence step 7). Covers both `ToolResultContent` variants:
 * `text` (the only variant Deus's real `ChatDisplayEvent`/`TranscriptEntry`
 * shape can produce today — see that file's header) and `diff` (no live
 * producer yet, exercised only here — see the same header for why).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import { ToolResultDisplay } from './ToolResultDisplay.js';

afterEach(() => {
  cleanup();
});

describe('ToolResultDisplay', () => {
  it('renders text content', () => {
    const { lastFrame } = render(
      <ToolResultDisplay
        result={{ type: 'text', text: 'Read 42 lines from foo.ts' }}
        terminalWidth={80}
      />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('Read 42 lines from foo.ts');
  });

  it('renders nothing for blank text content', () => {
    const { lastFrame } = render(
      <ToolResultDisplay result={{ type: 'text', text: '   ' }} terminalWidth={80} />,
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('renders a diff result via the wired DiffRenderer path', () => {
    const diffContent = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-const x = 1;',
      '+const x = 2;',
    ].join('\n');

    const { lastFrame } = render(
      <ToolResultDisplay
        result={{ type: 'diff', diffContent, filename: 'foo.ts' }}
        terminalWidth={80}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('const x = 1;');
    expect(frame).toContain('const x = 2;');
  });
});
