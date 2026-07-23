import { describe, expect, it } from 'vitest';

import {
  backspaceHistorySearch,
  cancelHistorySearch,
  commitHistorySearch,
  createHistorySearchState,
  cycleHistorySearch,
  exitHistorySearch,
  findHistoryMatch,
  previewForHistorySearch,
  startHistorySearch,
  typeHistorySearchChar,
} from './history-search.js';

// Oldest-first, matching tuiReduce's `submit_input` append order.
const HISTORY = ['git status', 'npm run build', 'git commit -m fix', 'ls'];

describe('createHistorySearchState / startHistorySearch', () => {
  it('creates an inactive, empty state', () => {
    expect(createHistorySearchState()).toEqual({
      active: false,
      query: '',
      matchIndex: 0,
      savedInput: '',
    });
  });

  it('startHistorySearch saves the current input and activates', () => {
    expect(startHistorySearch('draft in progress')).toEqual({
      active: true,
      query: '',
      matchIndex: 0,
      savedInput: 'draft in progress',
    });
  });
});

describe('findHistoryMatch', () => {
  it('finds the most recent match first (matchIndex 0)', () => {
    const state = typeHistorySearchChar(startHistorySearch(''), 'g');
    // "g" matches "git commit -m fix" (idx 2, most recent) then "git status" (idx 0).
    expect(findHistoryMatch(HISTORY, state)).toBe('git commit -m fix');
  });

  it('steps to older matches as matchIndex increases', () => {
    let state = typeHistorySearchChar(startHistorySearch(''), 'g');
    state = { ...state, matchIndex: 1 };
    expect(findHistoryMatch(HISTORY, state)).toBe('git status');
  });

  it('returns undefined for an empty query', () => {
    expect(findHistoryMatch(HISTORY, startHistorySearch(''))).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    const state = typeHistorySearchChar(startHistorySearch(''), 'z');
    expect(findHistoryMatch(HISTORY, state)).toBeUndefined();
  });
});

describe('previewForHistorySearch', () => {
  it('previews the saved input while the query is empty', () => {
    expect(previewForHistorySearch(HISTORY, startHistorySearch('draft'))).toBe(
      'draft',
    );
  });

  it('previews the current match once a query matches something', () => {
    const state = typeHistorySearchChar(startHistorySearch('draft'), 'l');
    expect(previewForHistorySearch(HISTORY, state)).toBe('ls');
  });

  it('freezes (returns undefined) when the query matches nothing — caller must leave input untouched', () => {
    const state = typeHistorySearchChar(startHistorySearch('draft'), 'z');
    expect(previewForHistorySearch(HISTORY, state)).toBeUndefined();
  });
});

describe('typeHistorySearchChar / backspaceHistorySearch', () => {
  it('typing extends the query and resets matchIndex to 0', () => {
    let state = startHistorySearch('');
    state = { ...typeHistorySearchChar(state, 'g'), matchIndex: 2 };
    state = typeHistorySearchChar(state, 'i');
    expect(state.query).toBe('gi');
    expect(state.matchIndex).toBe(0);
  });

  it('backspace shortens the query and resets matchIndex to 0', () => {
    let state = typeHistorySearchChar(startHistorySearch(''), 'g');
    state = typeHistorySearchChar(state, 'i');
    state = { ...state, matchIndex: 1 };
    state = backspaceHistorySearch(state);
    expect(state.query).toBe('g');
    expect(state.matchIndex).toBe(0);
  });
});

describe('cycleHistorySearch (Ctrl+R pressed again)', () => {
  it('advances matchIndex to the next-older match', () => {
    const typed = typeHistorySearchChar(startHistorySearch(''), 'g');
    const cycled = cycleHistorySearch(HISTORY, typed);
    expect(cycled.matchIndex).toBe(1);
    expect(findHistoryMatch(HISTORY, cycled)).toBe('git status');
  });

  it('rolls back (does not advance) once there are no more matches', () => {
    const typed = typeHistorySearchChar(startHistorySearch(''), 'g');
    const atLast = cycleHistorySearch(HISTORY, typed); // matchIndex 1, "git status"
    const pastEnd = cycleHistorySearch(HISTORY, atLast); // would be matchIndex 2 — no third "g" match
    expect(pastEnd.matchIndex).toBe(1);
    expect(findHistoryMatch(HISTORY, pastEnd)).toBe('git status');
  });
});

describe('commitHistorySearch / cancelHistorySearch / exitHistorySearch', () => {
  it('commit resolves to the current match', () => {
    const state = typeHistorySearchChar(startHistorySearch('draft'), 'l');
    expect(commitHistorySearch(HISTORY, state)).toBe('ls');
  });

  it('commit resolves to undefined (freeze) when nothing matches', () => {
    const state = typeHistorySearchChar(startHistorySearch('draft'), 'z');
    expect(commitHistorySearch(HISTORY, state)).toBeUndefined();
  });

  it('cancel always restores the saved input regardless of any match found', () => {
    const state = typeHistorySearchChar(startHistorySearch('draft'), 'l');
    expect(cancelHistorySearch(state)).toBe('draft');
  });

  it('exitHistorySearch resets to the initial inactive state', () => {
    expect(exitHistorySearch()).toEqual(createHistorySearchState());
  });
});
