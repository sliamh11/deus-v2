/**
 * Component test for `ToolCallItem.tsx`'s build-sequence-step-7 wiring:
 * confirms the real tool-call mounting point (which `MessageList.tsx`
 * routes every `kind: 'tool'` `TranscriptEntry` through) now renders
 * through the ported `ToolGroupDisplay`/`ToolMessage` family instead of the
 * prior step's flat placeholder `<Text>{entry.text}</Text>`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';

import type { TranscriptEntry } from '../../deus-tui-state.js';
import { ToolCallItem } from './ToolCallItem.js';

afterEach(() => {
  cleanup();
});

describe('ToolCallItem', () => {
  it('renders a tool entry through the real ToolGroupDisplay/ToolMessage components', () => {
    const entry: TranscriptEntry = { id: 0, kind: 'tool', text: 'web_search("deus")' };
    const { lastFrame } = render(<ToolCallItem entry={entry} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('web_search("deus")');
    // The bordered ToolMessage box (round border glyphs), not a bare line.
    expect(frame).toMatch(/[╭╮╰╯│─]/);
  });
});
