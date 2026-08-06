/**
 * scrollAnchoringDetect 回归测试 — 响应 mr-16 review #1。
 *
 * 关键 case:
 *  - anchoring 真生效(scrollTop 增量 ≈ heightDelta)→ true,F-SYNC-2 skip
 *  - anchoring 没生效(scrollTop 不动 / 增量与 delta 不匹配)→ false
 *  - 反向滚动(用户手动下滑让 scrollTop 减小)→ false
 *  - 内容收缩(heightDelta<=0)→ false
 *  - 边界:容差边缘
 */

import { describe, it, expect } from 'vitest';
import {
  detectScrollAnchoringApplied,
  ANCHORING_TOLERANCE_PX,
} from '../components/chat/scrollAnchoringDetect';

describe('detectScrollAnchoringApplied', () => {
  it('returns true when scrollTop delta ≈ height delta (anchoring did its job)', () => {
    // prepend 5392 px 内容,浏览器 anchoring 让 scrollTop 加了 5392(完美补偿)
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 26 + 5392,
      }),
    ).toBe(true);
  });

  it('returns true when scrollTop delta differs from height delta within tolerance', () => {
    // anchor 元素不完美贴顶,scrollTop 增量比 delta 少 30(在 50 容差内)
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 26 + 5392 - 30,
      }),
    ).toBe(true);
  });

  it('returns false when scrollTop did not move (anchoring did not engage)', () => {
    // viewport 没合适锚点元素,Chromium 跳过了自动补偿,scrollTop 没变
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 26,
      }),
    ).toBe(false);
  });

  it('returns false for unrelated programmatic / user scroll between snapshot and effect', () => {
    // 边界场景(review #1 担心):onLoadMore→effect 间隙用户手动下滑了 200px,
    // scrollTop 增量 200,与 delta=5392 差远了 → anchoring 应判定未生效,
    // F-SYNC-2 仍应补偿(否则 viewport 跳变)
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 26 + 200,
      }),
    ).toBe(false);
  });

  it('returns false when user scrolled up (negative delta) between snapshot and effect', () => {
    // 极端边界:用户在间隙里继续上滑(scrollTop 反而减小),与 anchoring 加 delta
    // 的方向相反 → 必然不是 anchoring → false
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 0,
      }),
    ).toBe(false);
  });

  it('returns false when content height did not grow (no prepend)', () => {
    // 内容反而收缩(理论上不该发生,防御性边界):heightDelta<=0 → 不是 prepend
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 11380,
        prevScrollTop: 100,
        currentScrollHeight: 5988,
        currentScrollTop: 100,
      }),
    ).toBe(false);
  });

  it('treats exact tolerance boundary as not anchoring (strict <)', () => {
    // 差值 = 容差(50)的临界:严格 < tolerance,所以恰好 50 不算 anchoring
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 26,
        currentScrollHeight: 11380,
        currentScrollTop: 26 + 5392 - ANCHORING_TOLERANCE_PX,
      }),
    ).toBe(false);
  });

  it('returns true when prepend happens at scrollTop=0 with anchoring engaged', () => {
    // 回归锁:已经滚到最顶端时触发 expand/load,prevScrollTop=0。
    // viewport 顶刚好有锚点元素,anchoring 强烈生效,把 scrollTop 加到等于
    // heightDelta(浏览器实际行为)。检测必须判 true → 让 F-SYNC-2 skip 手动
    // 补偿,否则双补偿把 viewport 直接推过新插入区域。
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 0,
        currentScrollHeight: 11380,
        currentScrollTop: 5392,
      }),
    ).toBe(true);
  });

  it('returns false when prepend happens at scrollTop=0 and anchoring did not engage', () => {
    // 镜像 case:同样 prevScrollTop=0,但 viewport 内没合适锚点元素,Chromium
    // 跳过 anchoring,scrollTop 留在 0。检测必须判 false → F-SYNC-2 走手动
    // 补偿,否则 viewport 停在 0 不动,新插入内容把用户原本看的部分推到屏外。
    expect(
      detectScrollAnchoringApplied({
        prevScrollHeight: 5988,
        prevScrollTop: 0,
        currentScrollHeight: 11380,
        currentScrollTop: 0,
      }),
    ).toBe(false);
  });
});
