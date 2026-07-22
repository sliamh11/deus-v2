/**
 * Component tests for the re-typed `ToolMessage.tsx` (build-sequence
 * step 7). `entry` is a real `TranscriptEntry` (`kind: 'tool'`) shape, the
 * same shape `tuiReduce` produces from a real `tool_use` `ChatDisplayEvent`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { ToolMessage } from './ToolMessage.js';

afterEach(() => {
  cleanup();
});

function toolEntry(text: string, id = 0): TranscriptEntry {
  return { id, kind: 'tool', text };
}

describe('ToolMessage', () => {
  it('renders the entry label in the header line', () => {
    const { lastFrame } = render(
      <ToolMessage entry={toolEntry('read_file(foo.ts)')} terminalWidth={80} />,
    );
    expect(stripAnsi(lastFrame() ?? '')).toContain('read_file(foo.ts)');
  });

  it('does not render a separate result box when no result is supplied', () => {
    const { lastFrame } = render(
      <ToolMessage entry={toolEntry('read_file(foo.ts)')} terminalWidth={80} />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    // The label appears exactly once — no duplicated echo into a result body.
    const occurrences = frame.split('read_file(foo.ts)').length - 1;
    expect(occurrences).toBe(1);
  });

  it('renders an explicit text result in a separate body box', () => {
    const { lastFrame } = render(
      <ToolMessage
        entry={toolEntry('list_dir(.)')}
        terminalWidth={80}
        result={{ type: 'text', text: 'foo.ts\nbar.ts' }}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('list_dir(.)');
    expect(frame).toContain('foo.ts');
    expect(frame).toContain('bar.ts');
  });
});
