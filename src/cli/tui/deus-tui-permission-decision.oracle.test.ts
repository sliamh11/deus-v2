import { describe, expect, it } from 'vitest';

import { keyToPermissionDecision } from './deus-tui-permission-decision.js';

describe('@oracle permission-modal keypress decisions', () => {
  it.each([
    { input: 'y', key: {}, label: 'lowercase shortcut' },
    { input: 'Y', key: {}, label: 'uppercase shortcut' },
    { input: 'yes', key: { return: true }, label: 'lowercase full word' },
    { input: 'YES', key: { return: true }, label: 'uppercase full word' },
    {
      input: '  YeS  ',
      key: { return: true },
      label: 'trimmed mixed-case full word',
    },
  ])('maps $label to allow_once', ({ input, key }) => {
    // @oracle: Track B — y/yes is a case-insensitive, trimmed allow-once choice.
    expect(keyToPermissionDecision(input, key)).toBe('allow_once');
  });

  it.each([
    { input: 'a', key: {}, label: 'lowercase shortcut' },
    { input: 'A', key: {}, label: 'uppercase shortcut' },
    {
      input: 'always',
      key: { return: true },
      label: 'lowercase full word',
    },
    {
      input: 'Always',
      key: { return: true },
      label: 'mixed-case full word',
    },
    {
      input: '  ALWAYS  ',
      key: { return: true },
      label: 'trimmed uppercase full word',
    },
  ])('maps $label to allow_always', ({ input, key }) => {
    // @oracle: Track B — a/always is a case-insensitive, trimmed always-allow choice.
    expect(keyToPermissionDecision(input, key)).toBe('allow_always');
  });

  it.each([
    { input: 'n', key: {}, label: 'lowercase shortcut' },
    { input: 'N', key: {}, label: 'uppercase shortcut' },
    { input: 'no', key: { return: true }, label: 'lowercase full word' },
    { input: 'NO', key: { return: true }, label: 'uppercase full word' },
    {
      input: '  No  ',
      key: { return: true },
      label: 'trimmed mixed-case full word',
    },
    { input: '', key: { return: true }, label: 'bare Enter' },
  ])('maps $label to deny', ({ input, key }) => {
    // @oracle: Track B — n/no and bare Enter preserve the CLI's fail-closed deny behavior.
    expect(keyToPermissionDecision(input, key)).toBe('deny');
  });

  it.each([
    { input: 'maybe', key: { return: true } },
    { input: 'x', key: {} },
    { input: '123', key: { return: true } },
    { input: '', key: {} },
  ])('keeps unrecognized input %j unresolved', ({ input, key }) => {
    // @oracle: Track B — unknown text and non-Enter empty input must re-prompt, not resolve.
    expect(keyToPermissionDecision(input, key)).toBeUndefined();
  });

  it.each([
    { input: 'ye', key: { return: true } },
    { input: 'al', key: { return: true } },
  ])('does not guess a decision for partial word %j', ({ input, key }) => {
    // @oracle: Track B — near-miss partial words must stay unresolved rather than authorize or deny by prefix.
    expect(keyToPermissionDecision(input, key)).toBeUndefined();
  });
});
