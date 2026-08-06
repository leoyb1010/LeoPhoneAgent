// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { __testing } from '../DraggableCardColumns';

function card(id: string) {
  const el = document.createElement('div');
  el.dataset.cardId = id;
  return el;
}

function ids(col: HTMLElement) {
  return Array.from(col.querySelectorAll<HTMLElement>(':scope > [data-card-id]')).map(
    (node) => node.dataset.cardId,
  );
}

describe('DraggableCardColumns ordering helpers', () => {
  it('flattens visual column buckets back into the shared row-major pinned order', () => {
    expect(
      __testing.flattenRoundRobinBuckets([
        ['a', 'd'],
        ['b'],
        ['c'],
      ]),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('derives row-major rank from row and column slots', () => {
    expect(__testing.rowMajorRank(0, 0, 3)).toBe(0);
    expect(__testing.rowMajorRank(0, 2, 3)).toBe(2);
    expect(__testing.rowMajorRank(1, 0, 3)).toBe(3);
    expect(__testing.rowMajorRank(1, 2, 3)).toBe(5);
  });

  it('restores every column to the original snapshot after same-column upward movement', () => {
    const col0 = document.createElement('div');
    const col1 = document.createElement('div');
    col0.append(card('a'), card('c'), card('e'));
    col1.append(card('b'), card('d'));

    // SortableJS has already moved e upward inside the same column before onEnd.
    col0.insertBefore(col0.children[2], col0.children[0]);
    expect(ids(col0)).toEqual(['e', 'a', 'c']);

    __testing.restoreColumnDomOrder([col0, col1], [
      ['a', 'c', 'e'],
      ['b', 'd'],
    ]);

    expect(ids(col0)).toEqual(['a', 'c', 'e']);
    expect(ids(col1)).toEqual(['b', 'd']);
  });

  it('derives cross-column insertion from the dropped column slot', () => {
    expect(__testing.reorderByDropSlot(['a', 'b', 'c', 'd'], 'c', 1, 1, 2)).toEqual([
      'a',
      'b',
      'd',
      'c',
    ]);
    expect(__testing.reorderByDropSlot(['a', 'b', 'c', 'd'], 'a', 1, 1, 2)).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('preserves sparse target slots instead of flattening them away', () => {
    expect(__testing.reorderByDropSlot(['a', 'b', 'c', 'd'], 'c', 1, 1, 2)).toEqual([
      'a',
      'b',
      'd',
      'c',
    ]);
    expect(__testing.reorderByDropSlot(['a', 'b', 'c', 'd'], 'c', 1, 0, 2)).toEqual([
      'a',
      'c',
      'b',
      'd',
    ]);
  });
});
