import { describe, expect, it } from 'vitest';

import {
  activatePendingQueueRowFocus,
  activatePendingQueueRowHover,
  deactivatePendingQueueRowFocus,
  deactivatePendingQueueRowHover,
  emptyPendingQueueRowActivityState,
  isPendingQueueRowActive,
  prunePendingQueueRowActivity,
} from '@/components/new-chat/pendingQueueRowActivity';

describe('pendingQueueRowActivity', () => {
  it('clears hover activity when the pointer leaves the same row', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);

    expect(isPendingQueueRowActive(hovered, 'row-a')).toBe(true);
    expect(deactivatePendingQueueRowHover(hovered, 'row-a')).toEqual(
      emptyPendingQueueRowActivityState,
    );
  });

  it('does not let a stale mouseleave clear a newer hovered row', () => {
    const rowA = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const rowB = activatePendingQueueRowHover(rowA, 'row-b', null);

    expect(deactivatePendingQueueRowHover(rowB, 'row-a')).toBe(rowB);
    expect(isPendingQueueRowActive(rowB, 'row-b')).toBe(true);
  });

  it('keeps keyboard focus activity after hover leaves', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const focused = activatePendingQueueRowFocus(hovered, 'row-a');
    const hoverLeft = deactivatePendingQueueRowHover(focused, 'row-a');

    expect(isPendingQueueRowActive(hoverLeft, 'row-a')).toBe(true);
    expect(deactivatePendingQueueRowFocus(hoverLeft, 'row-a')).toEqual(
      emptyPendingQueueRowActivityState,
    );
  });

  it('does not move hover while an edit lock is active', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);

    expect(activatePendingQueueRowHover(hovered, 'row-b', 'row-a')).toBe(hovered);
  });

  it('prunes activity for rows that left the queue', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const focused = activatePendingQueueRowFocus(hovered, 'row-b');

    expect(prunePendingQueueRowActivity(focused, ['row-b'])).toEqual({
      hoveredClientId: null,
      focusedClientId: 'row-b',
    });
  });
});
