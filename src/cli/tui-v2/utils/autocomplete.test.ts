import { describe, expect, it } from 'vitest';

import {
  applyAutocompleteAcceptance,
  autocompleteTargetKey,
  extractAutocompleteTarget,
  filterCommandSuggestions,
  filterMentionSuggestions,
  type CommandLike,
} from './autocomplete.js';

const FAKE_COMMANDS: CommandLike[] = [
  { name: 'plan', description: 'Toggle plan mode' },
  { name: 'status', description: 'Show status' },
  { name: 'exit', altNames: ['quit'], description: 'Exit' },
  { name: 'theme', description: 'Change theme' },
  { name: 'clear', description: 'Clear transcript' },
  { name: 'copy', description: 'Copy last response' },
  { name: 'help', description: 'Show help' },
];

describe('extractAutocompleteTarget', () => {
  it('returns undefined for plain text', () => {
    expect(extractAutocompleteTarget('hello world')).toBeUndefined();
  });

  it('recognizes a bare slash as an empty-query slash target', () => {
    expect(extractAutocompleteTarget('/')).toEqual({
      kind: 'slash',
      range: { start: 0, end: 1 },
      query: '',
    });
  });

  it('recognizes a growing slash query', () => {
    expect(extractAutocompleteTarget('/pl')).toEqual({
      kind: 'slash',
      range: { start: 0, end: 3 },
      query: 'pl',
    });
  });

  it('closes the slash target once a space is typed (falls through to args)', () => {
    expect(extractAutocompleteTarget('/plan on')).toBeUndefined();
  });

  it('does not treat a mid-line slash as a target', () => {
    expect(extractAutocompleteTarget('foo /bar')).toBeUndefined();
  });

  it('recognizes a trailing @-mention with no slash', () => {
    const value = 'review @src/cli';
    expect(extractAutocompleteTarget(value)).toEqual({
      kind: 'mention',
      range: { start: 7, end: value.length },
      query: 'src/cli',
      dirPart: 'src',
      segmentPrefix: 'cli',
    });
  });

  it('splits a bare (no-slash) mention query as dirPart="" ', () => {
    expect(extractAutocompleteTarget('@cli')).toEqual({
      kind: 'mention',
      range: { start: 0, end: 4 },
      query: 'cli',
      dirPart: '',
      segmentPrefix: 'cli',
    });
  });

  it('treats a trailing slash on the mention as an empty segment prefix (list the directory itself)', () => {
    expect(extractAutocompleteTarget('@src/')).toEqual({
      kind: 'mention',
      range: { start: 0, end: 5 },
      query: 'src/',
      dirPart: 'src',
      segmentPrefix: '',
    });
  });

  it('only autocompletes the LAST mention when it is the active (trailing) one', () => {
    expect(extractAutocompleteTarget('@a/b and more text')).toBeUndefined();
  });

  it('does not trigger on an escaped @', () => {
    expect(extractAutocompleteTarget('email me \\@')).toBeUndefined();
  });
});

describe('filterCommandSuggestions', () => {
  it('returns every command for an empty query, preserving registration order', () => {
    const result = filterCommandSuggestions(FAKE_COMMANDS, '');
    expect(result.map((r) => r.insertText)).toEqual([
      'plan',
      'status',
      'exit',
      'theme',
      'clear',
      'copy',
      'help',
    ]);
  });

  it('filters by case-insensitive name prefix', () => {
    const result = filterCommandSuggestions(FAKE_COMMANDS, 'pl');
    expect(result).toEqual([
      { insertText: 'plan', label: '/plan — Toggle plan mode' },
    ]);
  });

  it('matches on an alt name too', () => {
    const result = filterCommandSuggestions(FAKE_COMMANDS, 'qui');
    expect(result).toEqual([{ insertText: 'exit', label: '/exit — Exit' }]);
  });

  it('returns nothing for a query matching no command', () => {
    expect(filterCommandSuggestions(FAKE_COMMANDS, 'zzz')).toEqual([]);
  });
});

describe('filterMentionSuggestions', () => {
  const entries = ['Composer.tsx', 'App.tsx', 'commands/', 'contexts/'];

  it('filters entries by case-sensitive prefix and sorts alphabetically', () => {
    expect(filterMentionSuggestions(entries, 'c')).toEqual([
      { insertText: 'commands/', label: 'commands/' },
      { insertText: 'contexts/', label: 'contexts/' },
    ]);
  });

  it('returns every entry, sorted, for an empty prefix', () => {
    expect(
      filterMentionSuggestions(entries, '').map((r) => r.insertText),
    ).toEqual(['App.tsx', 'commands/', 'Composer.tsx', 'contexts/']);
  });

  it('is case sensitive (does not match a different-case prefix)', () => {
    expect(filterMentionSuggestions(entries, 'C')).toEqual([
      { insertText: 'Composer.tsx', label: 'Composer.tsx' },
    ]);
  });
});

describe('applyAutocompleteAcceptance', () => {
  it('replaces the whole buffer for a slash acceptance', () => {
    const target = extractAutocompleteTarget('/pl');
    expect(target).toBeDefined();
    const result = applyAutocompleteAcceptance('/pl', target!, {
      insertText: 'plan',
      label: '/plan — Toggle plan mode',
    });
    expect(result).toBe('/plan');
  });

  it('replaces only the active mention, preserving everything before it', () => {
    const value = 'review @src/cli';
    const target = extractAutocompleteTarget(value);
    expect(target).toBeDefined();
    const result = applyAutocompleteAcceptance(value, target!, {
      insertText: 'cli-runtime.ts',
      label: 'cli-runtime.ts',
    });
    expect(result).toBe('review @src/cli-runtime.ts');
  });

  it('retains a trailing slash when the accepted suggestion is a directory', () => {
    const value = 'review @src/cl';
    const target = extractAutocompleteTarget(value);
    expect(target).toBeDefined();
    const result = applyAutocompleteAcceptance(value, target!, {
      insertText: 'cli/',
      label: 'cli/',
    });
    expect(result).toBe('review @src/cli/');
  });

  it('handles a bare (no dirPart) mention acceptance', () => {
    const value = '@cl';
    const target = extractAutocompleteTarget(value);
    expect(target).toBeDefined();
    const result = applyAutocompleteAcceptance(value, target!, {
      insertText: 'cli/',
      label: 'cli/',
    });
    expect(result).toBe('@cli/');
  });
});

describe('autocompleteTargetKey', () => {
  it('returns undefined for no target', () => {
    expect(autocompleteTargetKey(undefined)).toBeUndefined();
  });

  it('differs between different slash queries', () => {
    const a = autocompleteTargetKey(extractAutocompleteTarget('/p'));
    const b = autocompleteTargetKey(extractAutocompleteTarget('/pl'));
    expect(a).not.toBe(b);
  });

  it('differs between different mention dir/segment combinations', () => {
    const a = autocompleteTargetKey(extractAutocompleteTarget('@src/c'));
    const b = autocompleteTargetKey(extractAutocompleteTarget('@src/cl'));
    expect(a).not.toBe(b);
  });
});
