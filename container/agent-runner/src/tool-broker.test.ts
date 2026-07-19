import { describe, it, expect } from 'vitest';
import { createPinnedLookup } from './tool-broker.js';

describe('createPinnedLookup (LIA-456)', () => {
  it('returns the single (address, family) triple when options.all is falsy', () => {
    const lookup = createPinnedLookup('93.184.216.34', 4);
    let received: unknown[] = [];
    lookup(
      'example.com',
      { all: false } as Parameters<typeof lookup>[1],
      (...args) => {
        received = args;
      },
    );
    expect(received).toEqual([null, '93.184.216.34', 4]);
  });

  it('returns a LookupAddress[] when options.all is true (Node 20+/22 Happy-Eyeballs dual-stack contract)', () => {
    const lookup = createPinnedLookup(
      '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
      6,
    );
    let received: unknown[] = [];
    lookup(
      'example.com',
      { all: true } as Parameters<typeof lookup>[1],
      (...args) => {
        received = args;
      },
    );
    expect(received).toEqual([
      null,
      [{ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 }],
    ]);
  });
});
