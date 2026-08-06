import { describe, expect, it, vi } from 'vitest';

import { hasTextSelectionAtPoint } from '../hooks/useDisableContextMenu';

function rects(...values: Array<Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>>): DOMRectList {
  return {
    item: (index: number) => values[index] as DOMRect,
    length: values.length,
  } as DOMRectList;
}

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    getRangeAt: vi.fn(() => ({
      getClientRects: () => rects({ bottom: 30, left: 10, right: 80, top: 20 }),
    }) as unknown as Range),
    isCollapsed: false,
    rangeCount: 1,
    toString: () => 'selected',
    ...overrides,
  } as Selection;
}

describe('read-only selection context-menu gate', () => {
  it('allows a non-empty selection only when the right-click point hits a selection rect', () => {
    const current = selection();
    expect(hasTextSelectionAtPoint(40, 25, current)).toBe(true);
    expect(hasTextSelectionAtPoint(90, 25, current)).toBe(false);
    expect(hasTextSelectionAtPoint(40, 35, current)).toBe(false);
  });

  it('checks every rect for multi-line and multi-range selections', () => {
    const current = selection({
      getRangeAt: vi.fn((index: number) => ({
        getClientRects: () => index === 0
          ? rects({ bottom: 20, left: 10, right: 80, top: 10 })
          : rects({ bottom: 50, left: 10, right: 45, top: 40 }),
      }) as unknown as Range),
      rangeCount: 2,
    });

    expect(hasTextSelectionAtPoint(30, 45, current)).toBe(true);
    expect(hasTextSelectionAtPoint(70, 45, current)).toBe(false);
  });

  it('keeps empty and collapsed selections suppressed', () => {
    expect(hasTextSelectionAtPoint(40, 25, null)).toBe(false);
    expect(hasTextSelectionAtPoint(40, 25, selection({ isCollapsed: true }))).toBe(false);
    expect(hasTextSelectionAtPoint(40, 25, selection({ toString: () => '   ' }))).toBe(false);
  });
});
