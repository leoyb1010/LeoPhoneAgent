import { describe, expect, it } from 'vitest';

import { computeTriggerRange, isDroppableRect, isPointerInTargetZone } from '../PanelDragController';

/**
 * 拖面板原型的落点判定单测 —— 高亮/提交共用同一区间(所见即所得)。
 * 手势/拖影是 dev-only 交互原型,黑盒验;这里只锁纯判定逻辑不回归。
 */
describe('computeTriggerRange', () => {
  // 目标面板矩形 [800, 1400],默认入界余量 12。
  const LEFT = 800;
  const RIGHT = 1400;

  it('源在目标左侧 → 只内缩目标左边缘(共享边),右缘到底', () => {
    expect(computeTriggerRange(LEFT, RIGHT, true)).toEqual({ left: 812, right: 1400 });
  });

  it('源在目标右侧 → 只内缩目标右边缘(共享边),左缘到底', () => {
    expect(computeTriggerRange(LEFT, RIGHT, false)).toEqual({ left: 800, right: 1388 });
  });

  it('自定义余量生效', () => {
    expect(computeTriggerRange(LEFT, RIGHT, true, 50)).toEqual({ left: 850, right: 1400 });
  });
});

describe('isPointerInTargetZone', () => {
  const range = { left: 812, right: 1400 };

  it('区间内 → true(含两端)', () => {
    expect(isPointerInTargetZone(812, range)).toBe(true);
    expect(isPointerInTargetZone(1000, range)).toBe(true);
    expect(isPointerInTargetZone(1400, range)).toBe(true);
  });

  it('区间外 → false(共享边内缩生效:811 仍在目标矩形里但不点亮)', () => {
    expect(isPointerInTargetZone(811, range)).toBe(false);
    expect(isPointerInTargetZone(1401, range)).toBe(false);
    expect(isPointerInTargetZone(0, range)).toBe(false);
  });

  it('非法区间(right ≤ left)→ false,不抛错', () => {
    expect(isPointerInTargetZone(500, { left: 900, right: 800 })).toBe(false);
    expect(isPointerInTargetZone(700, { left: 700, right: 700 })).toBe(false);
  });
});

describe('isDroppableRect', () => {
  it('正常面板矩形够格当落点', () => {
    expect(isDroppableRect(300, 800)).toBe(true);
  });

  it('折叠(w-0)/隐藏(全 0)/窄条的面板没有身体,不算落点', () => {
    expect(isDroppableRect(0, 800)).toBe(false); // 右栏折叠 w-0
    expect(isDroppableRect(0, 0)).toBe(false); // display:none
    expect(isDroppableRect(300, 0)).toBe(false);
    expect(isDroppableRect(20, 800)).toBe(false); // 低于最小身体尺寸
  });
});
