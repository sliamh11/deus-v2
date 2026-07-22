/**
 * Component tests for the re-typed `ToolGroupDisplay.tsx` (build-sequence
 * step 7). Exercises both the single-entry shape `ToolCallItem.tsx` (the
 * real live mounting point) actually uses, and genuine multi-entry grouping
 * — which has no live caller yet (see that file's header) but is real,
 * working behavior, verified here directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { ToolGroupDisplay } from './ToolGroupDisplay.js';

afterEach(() => {
  cleanup();
});

function toolEntry(id: number, text: string): TranscriptEntry {
  return { id, kind: 'tool', text };
}

describe('ToolGroupDisplay', () => {
  it('renders nothing for an empty entries array', () => {
    const { lastFrame } = render(
      <ToolGroupDisplay entries={[]} terminalWidth={80} />,
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('renders a single entry (the real ToolCallItem.tsx shape)', () => {
    const { lastFrame } = render(
      <ToolGroupDisplay entries={[toolEntry(0, 'grep(TODO)')]} terminalWidth={80} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('grep(TODO)');
  });

  it('renders multiple consecutive tool entries in one group', () => {
    const entries = [
      toolEntry(0, 'read_file(a.ts)'),
      toolEntry(1, 'read_file(b.ts)'),
      toolEntry(2, 'read_file(c.ts)'),
    ];
    const { lastFrame } = render(
      <ToolGroupDisplay entries={entries} terminalWidth={80} />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('read_file(a.ts)');
    expect(frame).toContain('read_file(b.ts)');
    expect(frame).toContain('read_file(c.ts)');
  });
});
