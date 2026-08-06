import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SHEET_DISMISS_RATIO,
  applyContextSheetDrag,
  computeContextSheetSnapHeights,
  settleContextSheetDrag,
} from '@/session/contextSheetModel';

describe('contextSheet', () => {
  it('computes half/full snap heights from screen height', () => {
    const heights = computeContextSheetSnapHeights({ safeAreaTopInset: 59, screenHeight: 844 });
    expect(heights.half).toBe(Math.round(844 * 0.56));
    expect(heights.full).toBe(844 - 71);
    expect(heights.full).toBeGreaterThan(heights.half);
  });

  it('keeps half readable on short screens and never exceeds full', () => {
    const heights = computeContextSheetSnapHeights({ screenHeight: 480 });
    expect(heights.half).toBeGreaterThanOrEqual(320);
    expect(heights.half).toBeLessThanOrEqual(heights.full);
  });

  it('falls back to a sane default for invalid screen height', () => {
    const heights = computeContextSheetSnapHeights({ screenHeight: Number.NaN });
    expect(heights.half).toBeGreaterThan(0);
    expect(heights.full).toBeGreaterThanOrEqual(heights.half);
  });

  it('tracks upward drags and clamps at full height', () => {
    const heights = { full: 780, half: 470 };
    expect(applyContextSheetDrag({ heights, startHeight: 470, translationY: -100 })).toBe(570);
    expect(applyContextSheetDrag({ heights, startHeight: 470, translationY: -900 })).toBe(780);
  });

  it('tracks downward drags below half for dismiss detection', () => {
    const heights = { full: 780, half: 470 };
    expect(applyContextSheetDrag({ heights, startHeight: 470, translationY: 200 })).toBe(270);
    expect(applyContextSheetDrag({ heights, startHeight: 470, translationY: 900 })).toBe(0);
  });

  it('settles to the nearest snap point', () => {
    const heights = { full: 780, half: 470 };
    const midpoint = (heights.half + heights.full) / 2;
    expect(settleContextSheetDrag({ draggedHeight: midpoint + 1, heights })).toBe('full');
    expect(settleContextSheetDrag({ draggedHeight: midpoint - 1, heights })).toBe('half');
    expect(settleContextSheetDrag({ draggedHeight: heights.half, heights })).toBe('half');
    expect(settleContextSheetDrag({ draggedHeight: heights.full, heights })).toBe('full');
  });

  it('dismisses when released well below the half snap', () => {
    const heights = { full: 780, half: 470 };
    const dismissBelow = heights.half * CONTEXT_SHEET_DISMISS_RATIO;
    expect(settleContextSheetDrag({ draggedHeight: dismissBelow - 1, heights })).toBe('dismiss');
    expect(settleContextSheetDrag({ draggedHeight: dismissBelow, heights })).toBe('half');
  });

  it('only offers full or dismiss when the screen clamps half to full', () => {
    const heights = { full: 470, half: 470 };
    expect(settleContextSheetDrag({ draggedHeight: 470, heights })).toBe('full');
    expect(settleContextSheetDrag({ draggedHeight: 300, heights })).toBe('full');
    expect(settleContextSheetDrag({ draggedHeight: 200, heights })).toBe('dismiss');
  });
});
