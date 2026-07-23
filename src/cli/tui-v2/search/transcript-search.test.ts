import { describe, expect, it } from 'vitest';

import {
  createTranscriptSearchState,
  currentTranscriptMatch,
  exitTranscriptSearch,
  nextTranscriptMatch,
  prevTranscriptMatch,
  startTranscriptSearch,
  updateTranscriptSearchQuery,
  type TranscriptSearchEntry,
} from './transcript-search.js';

const ENTRIES: TranscriptSearchEntry[] = [
  { id: 0, text: 'Hello world' },
  { id: 1, text: 'the world is big' },
  { id: 2, text: 'nothing here' },
];

describe('createTranscriptSearchState / startTranscriptSearch', () => {
  it('creates an inactive, empty state', () => {
    expect(createTranscriptSearchState()).toEqual({
      active: false,
      query: '',
      matches: [],
      currentIndex: 0,
    });
  });

  it('startTranscriptSearch activates with an empty query', () => {
    expect(startTranscriptSearch()).toEqual({
      active: true,
      query: '',
      matches: [],
      currentIndex: 0,
    });
  });
});

describe('updateTranscriptSearchQuery', () => {
  it('finds case-insensitive matches across all entries, resetting currentIndex to 0', () => {
    const state = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      'world',
    );
    expect(state.matches).toEqual([
      { entryId: 0, offset: 6 },
      { entryId: 1, offset: 4 },
    ]);
    expect(state.currentIndex).toBe(0);
  });

  it('finds multiple matches within the same entry', () => {
    const entries: TranscriptSearchEntry[] = [{ id: 0, text: 'aa aa aa' }];
    const state = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      entries,
      'aa',
    );
    expect(state.matches).toEqual([
      { entryId: 0, offset: 0 },
      { entryId: 0, offset: 3 },
      { entryId: 0, offset: 6 },
    ]);
  });

  it('returns no matches for an empty query', () => {
    const state = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      '',
    );
    expect(state.matches).toEqual([]);
  });

  it('returns no matches when nothing contains the query', () => {
    const state = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      'xyz',
    );
    expect(state.matches).toEqual([]);
  });
});

describe('nextTranscriptMatch / prevTranscriptMatch', () => {
  const searched = updateTranscriptSearchQuery(
    startTranscriptSearch(),
    ENTRIES,
    'world',
  );

  it('nextTranscriptMatch wraps around at the end', () => {
    const first = nextTranscriptMatch(searched);
    expect(first.currentIndex).toBe(1);
    const wrapped = nextTranscriptMatch(first);
    expect(wrapped.currentIndex).toBe(0);
  });

  it('prevTranscriptMatch wraps around at the start', () => {
    const wrapped = prevTranscriptMatch(searched);
    expect(wrapped.currentIndex).toBe(1);
  });

  it('both no-op when there are zero matches', () => {
    const empty = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      'xyz',
    );
    expect(nextTranscriptMatch(empty)).toEqual(empty);
    expect(prevTranscriptMatch(empty)).toEqual(empty);
  });
});

describe('currentTranscriptMatch', () => {
  it('returns the match at currentIndex, or undefined with no matches', () => {
    const searched = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      'world',
    );
    expect(currentTranscriptMatch(searched)).toEqual({ entryId: 0, offset: 6 });
    expect(currentTranscriptMatch(nextTranscriptMatch(searched))).toEqual({
      entryId: 1,
      offset: 4,
    });
    expect(
      currentTranscriptMatch(createTranscriptSearchState()),
    ).toBeUndefined();
  });
});

describe('exitTranscriptSearch', () => {
  it('resets to the initial inactive state', () => {
    const searched = updateTranscriptSearchQuery(
      startTranscriptSearch(),
      ENTRIES,
      'world',
    );
    expect(exitTranscriptSearch()).toEqual(createTranscriptSearchState());
    void searched;
  });
});
