import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import {
  appendResolvedMentions,
  escapeAtSymbols,
  parseAllAtCommands,
  resolveAtMentions,
  unescapeLiteralAt,
  type AtMentionFsDeps,
} from './at-mention-processor.js';

describe('parseAllAtCommands', () => {
  it('splits plain text and one @path mention', () => {
    expect(parseAllAtCommands('look at @src/foo.ts please')).toEqual([
      { type: 'text', content: 'look at ' },
      { type: 'atPath', content: '@src/foo.ts' },
      { type: 'text', content: ' please' },
    ]);
  });

  it('finds multiple mentions in one line', () => {
    const parts = parseAllAtCommands('@a.ts and @b.ts');
    expect(parts.map((p) => p.content)).toEqual(['@a.ts', ' and ', '@b.ts']);
  });

  it('does not treat an escaped \\@ as a mention', () => {
    const parts = parseAllAtCommands('reach me \\@ home, ok?');
    expect(parts.every((p) => p.type === 'text')).toBe(true);
  });

  it('returns just the plain text when there are no mentions', () => {
    expect(parseAllAtCommands('no mentions here')).toEqual([
      { type: 'text', content: 'no mentions here' },
    ]);
  });

  it('stops a path at a delimiter like a comma', () => {
    const parts = parseAllAtCommands('see @foo.ts, thanks');
    expect(parts).toEqual([
      { type: 'text', content: 'see ' },
      { type: 'atPath', content: '@foo.ts' },
      { type: 'text', content: ', thanks' },
    ]);
  });
});

describe('escapeAtSymbols / unescapeLiteralAt', () => {
  it('round-trips a literal @ through escape/unescape', () => {
    const original = 'contact me@example.com about @file.ts';
    expect(unescapeLiteralAt(escapeAtSymbols(original))).toBe(original);
  });

  it('escapeAtSymbols does not double-escape an already-escaped @', () => {
    expect(escapeAtSymbols('a\\@b')).toBe('a\\@b');
  });
});

function fakeFsDeps(overrides: Partial<AtMentionFsDeps> = {}): AtMentionFsDeps {
  return {
    readFile: vi.fn(async () => {
      throw new Error('ENOENT');
    }),
    stat: vi.fn(async () => {
      throw new Error('ENOENT');
    }),
    readdir: vi.fn(async () => []),
    resolvePath: (cwd, name) => path.resolve(cwd, name),
    ...overrides,
  };
}

describe('resolveAtMentions', () => {
  it('resolves a real file mention and inlines its content', async () => {
    const deps = fakeFsDeps({
      stat: vi.fn(async () => ({ isDirectory: () => false })),
      readFile: vi.fn(async () => 'export const x = 1;\n'),
    });
    const result = await resolveAtMentions('check @src/foo.ts', '/work', deps);
    expect(result.errors).toEqual([]);
    expect(result.resolved).toEqual([
      {
        atPath: '@src/foo.ts',
        displayLabel: 'src/foo.ts',
        content: 'export const x = 1;\n',
      },
    ]);
  });

  it('resolves a directory mention as a listing', async () => {
    const deps = fakeFsDeps({
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => ['a.ts', 'b.ts']),
    });
    const result = await resolveAtMentions('see @src', '/work', deps);
    expect(result.resolved[0].content).toBe('[directory listing]\na.ts\nb.ts');
  });

  it('collects an error for a missing path without throwing', async () => {
    const deps = fakeFsDeps(); // stat always rejects
    const result = await resolveAtMentions('see @missing.ts', '/work', deps);
    expect(result.resolved).toEqual([]);
    expect(result.errors).toEqual(['@missing.ts: not found']);
  });

  it('resolves a real mention and reports a missing one in the same call, independently', async () => {
    const deps = fakeFsDeps({
      stat: vi.fn(async (p: string) => {
        if (p.endsWith('real.ts')) return { isDirectory: () => false };
        throw new Error('ENOENT');
      }),
      readFile: vi.fn(async () => 'hi'),
    });
    const result = await resolveAtMentions(
      '@real.ts and @missing.ts',
      '/work',
      deps,
    );
    expect(result.resolved).toEqual([
      { atPath: '@real.ts', displayLabel: 'real.ts', content: 'hi' },
    ]);
    expect(result.errors).toEqual(['@missing.ts: not found']);
  });

  it('truncates a file exceeding the byte cap', async () => {
    const huge = 'x'.repeat(300_000);
    const deps = fakeFsDeps({
      stat: vi.fn(async () => ({ isDirectory: () => false })),
      readFile: vi.fn(async () => huge),
    });
    const result = await resolveAtMentions('@big.txt', '/work', deps);
    expect(result.resolved[0].content.length).toBeLessThan(huge.length);
    expect(result.resolved[0].content).toContain('truncated');
  });

  it('returns no resolved/errors for text with no mentions', async () => {
    const deps = fakeFsDeps();
    const result = await resolveAtMentions(
      'just chatting, no paths',
      '/work',
      deps,
    );
    expect(result).toEqual({ resolved: [], errors: [] });
  });
});

describe('appendResolvedMentions', () => {
  it('returns the original text unchanged when nothing resolved', () => {
    expect(appendResolvedMentions('hi', { resolved: [], errors: [] })).toBe(
      'hi',
    );
  });

  it('appends one reference block per resolved mention', () => {
    const text = appendResolvedMentions('check this', {
      resolved: [
        { atPath: '@a.ts', displayLabel: 'a.ts', content: 'const a = 1;' },
      ],
      errors: [],
    });
    expect(text).toBe('check this\n\nContent from @a.ts:\nconst a = 1;');
  });
});
