import { describe, expect, it } from 'vitest';

import {
  PERMISSION_LIST_OPTIONS,
  permissionListKeyToResult,
} from './deus-tui-permission-decision-v2.js';

describe('@oracle permission-modal arrow-key decisions', () => {
  it('exposes exactly the three decisions in display order with their labels', () => {
    // @oracle: The permission list has exactly the specified three labeled choices in fixed cursor order.
    expect(PERMISSION_LIST_OPTIONS).toEqual([
      { decision: 'allow_once', label: 'Allow once' },
      { decision: 'allow_always', label: 'Always allow' },
      { decision: 'deny', label: 'Deny' },
    ]);
  });

  it.each([
    { currentIndex: 0, key: { downArrow: true }, expectedIndex: 1 },
    { currentIndex: 1, key: { downArrow: true }, expectedIndex: 2 },
    { currentIndex: 2, key: { upArrow: true }, expectedIndex: 1 },
    { currentIndex: 1, key: { upArrow: true }, expectedIndex: 0 },
  ])(
    'moves from index $currentIndex to $expectedIndex for $key',
    ({ currentIndex, key, expectedIndex }) => {
      // @oracle: Up and Down move the cursor exactly one option within the fixed three-item list.
      expect(permissionListKeyToResult(currentIndex, key)).toEqual({
        type: 'move',
        index: expectedIndex,
      });
    },
  );

  it.each([
    { currentIndex: 0, key: { upArrow: true }, boundary: 'top' },
    { currentIndex: 2, key: { downArrow: true }, boundary: 'bottom' },
  ])('hard-clamps at the $boundary boundary', ({ currentIndex, key }) => {
    // @oracle: Navigation hard-clamps, so an arrow past either boundary neither moves nor resolves.
    expect(permissionListKeyToResult(currentIndex, key)).toEqual({
      type: 'noop',
    });
  });

  it.each([
    { currentIndex: 0, decision: 'allow_once' },
    { currentIndex: 1, decision: 'allow_always' },
    { currentIndex: 2, decision: 'deny' },
  ] as const)(
    'resolves index $currentIndex to $decision only when Enter is pressed',
    ({ currentIndex, decision }) => {
      // @oracle: Enter is the sole confirmation action and resolves the decision at the current cursor index.
      expect(permissionListKeyToResult(currentIndex, { return: true })).toEqual(
        { type: 'resolve', decision },
      );
    },
  );

  it.each([
    { key: {}, label: 'an unrecognized key shape' },
    { key: { leftArrow: true }, label: 'Left arrow' },
    { key: { rightArrow: true }, label: 'Right arrow' },
    { key: { tab: true }, label: 'Tab' },
    { key: { escape: true }, label: 'Escape' },
    { key: { backspace: true }, label: 'Backspace' },
    { key: { input: 'y' }, label: 'the retired y shortcut' },
    { key: { input: 'a' }, label: 'the retired a shortcut' },
    { key: { input: 'n' }, label: 'the retired n shortcut' },
  ])('treats $label as inert', ({ key }) => {
    // @oracle: Any key other than Up, Down, or Enter is inert and typed-letter decisions remain retired.
    expect(permissionListKeyToResult(1, key)).toEqual({ type: 'noop' });
  });
});
