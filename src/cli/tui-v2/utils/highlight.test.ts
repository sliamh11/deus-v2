import { describe, expect, it } from 'vitest';

import { tokenizeComposerValue } from './highlight.js';

describe('tokenizeComposerValue', () => {
  it('returns an empty array for an empty buffer', () => {
    expect(tokenizeComposerValue('')).toEqual([]);
  });

  it('is lossless: concatenating every token exactly reconstructs the input', () => {
    const inputs = [
      'hello world',
      '/plan',
      '/pl',
      'review @src/cli then finish',
      'multiple @a/b and @c/d mentions',
      'trailing [Pasted Text: 3 lines] segment',
      '/plan on then @foo and [Pasted Text: 1 line]',
    ];
    for (const input of inputs) {
      const tokens = tokenizeComposerValue(input);
      expect(tokens.map((t) => t.text).join('')).toBe(input);
    }
  });

  it('tokenizes a plain string with no special runs as one plain token', () => {
    expect(tokenizeComposerValue('hello world')).toEqual([
      { kind: 'plain', text: 'hello world' },
    ]);
  });

  it('recognizes a leading slash-command token, growing keystroke by keystroke', () => {
    expect(tokenizeComposerValue('/')).toEqual([{ kind: 'slash', text: '/' }]);
    expect(tokenizeComposerValue('/p')).toEqual([
      { kind: 'slash', text: '/p' },
    ]);
    expect(tokenizeComposerValue('/pl')).toEqual([
      { kind: 'slash', text: '/pl' },
    ]);
  });

  it('stops the slash token at the first whitespace, leaving the rest plain', () => {
    expect(tokenizeComposerValue('/plan on')).toEqual([
      { kind: 'slash', text: '/plan' },
      { kind: 'plain', text: ' on' },
    ]);
  });

  it('does NOT treat a mid-line slash as a command token', () => {
    expect(tokenizeComposerValue('foo /bar')).toEqual([
      { kind: 'plain', text: 'foo /bar' },
    ]);
  });

  it('recognizes an @-mention anywhere in the buffer', () => {
    expect(tokenizeComposerValue('review @src/cli then finish')).toEqual([
      { kind: 'plain', text: 'review ' },
      { kind: 'mention', text: '@src/cli' },
      { kind: 'plain', text: ' then finish' },
    ]);
  });

  it('recognizes multiple @-mentions', () => {
    expect(tokenizeComposerValue('@a and @b')).toEqual([
      { kind: 'mention', text: '@a' },
      { kind: 'plain', text: ' and ' },
      { kind: 'mention', text: '@b' },
    ]);
  });

  it('does not treat an escaped \\@ as a mention', () => {
    expect(tokenizeComposerValue('email me \\@ home')).toEqual([
      { kind: 'plain', text: 'email me \\@ home' },
    ]);
  });

  it('recognizes a paste placeholder segment', () => {
    expect(
      tokenizeComposerValue('before [Pasted Text: 3 lines] after'),
    ).toEqual([
      { kind: 'plain', text: 'before ' },
      { kind: 'paste', text: '[Pasted Text: 3 lines]' },
      { kind: 'plain', text: ' after' },
    ]);
  });

  it('tokenizes slash, mention, and paste all in one line together', () => {
    const value = '/plan review @src/cli [Pasted Text: 2 lines]';
    const tokens = tokenizeComposerValue(value);
    expect(tokens[0]).toEqual({ kind: 'slash', text: '/plan' });
    expect(
      tokens.some((t) => t.kind === 'mention' && t.text === '@src/cli'),
    ).toBe(true);
    expect(
      tokens.some(
        (t) => t.kind === 'paste' && t.text === '[Pasted Text: 2 lines]',
      ),
    ).toBe(true);
  });
});
