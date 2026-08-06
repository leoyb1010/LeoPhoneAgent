/**
 * viewportFillDetect 回归测试。
 *
 * 覆盖维度:
 *  - 单条件触发/不触发 (scrollH===clientH / hasMore / !loading / attempt 上限)
 *  - 多条件组合短路顺序
 *  - 边界值 (attempt=maxAttempts-1 vs ==maxAttempts)
 *  - 自定义 maxAttempts
 *  - 子像素容差 (NO_SCROLL_TOLERANCE_PX 边界)
 *  - 用户向上滚动意图不受自动补载预算限制
 *  - 三种典型场景 (短 session DB 还能拉 / 长 session 已可滚 / 短 session DB 没历史)
 *    + 二段式 trace replay (回归锚点, 防止顺序写错)
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoLoadMoreHistory,
  shouldAutoExpandRenderWindow,
  decideAutoFillAction,
  decideUserIntentFillAction,
  MAX_AUTO_LOAD_ATTEMPTS,
  NO_SCROLL_TOLERANCE_PX,
  TOP_HISTORY_TRIGGER_PX,
} from '../components/chat/viewportFillDetect';

describe('shouldAutoLoadMoreHistory', () => {
  // ── 基础正向 ──
  it('returns true when viewport not scrollable AND has more AND not loading AND under attempt limit', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(true);
  });

  // ── 各单条件失败 ──
  it('returns false when viewport already scrollable (scrollH > clientH)', () => {
    // 长会话: 用户可手动滚到顶触发原生 onLoadMore, 不需要自动
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 22189,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('returns false when scrollH < clientH (defensive: should not happen in real DOM)', () => {
    // 浏览器层面 scrollHeight 永远 >= clientHeight, 这条防的是 sub-pixel 取整 /
    // 测试桩意外传错值时不要错误触发 IPC. |1300-1354|=54 > tolerance(1) → false.
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1300,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  // ── sub-pixel 容差 (NO_SCROLL_TOLERANCE_PX) ──
  // DPR≠1 (Windows 缩放 125%/150%, Retina) 环境下 sub-pixel 圆整可能让
  // scrollH = clientH + 1, 此时用户视觉滚不动但严格 !== 会判可滚 → 死锁复发.
  // 加 1px 容差保护; > 1px 才视为真"可滚".
  it('treats scrollH = clientH + 1 as no-scroll (sub-pixel tolerance)', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1355,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(true);
  });

  it('treats scrollH = clientH + 2 as scrollable (just past tolerance)', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1356,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('returns false when DB has no more older messages', () => {
    // U4 case: 新建会话, 无 DB 历史, 不该浪费 IPC
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: false,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('returns false when a load is already in flight', () => {
    // 防 IPC 重入: 上一批还在路上, 等它回来再判
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: true,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  // ── attempt 上限边界 ──
  it('returns true at attemptCount = maxAttempts - 1 (one slot remaining)', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS - 1,
      }),
    ).toBe(true);
  });

  it('returns false at attemptCount = maxAttempts (cutoff exact)', () => {
    // 退化保护: 已经拉到自动补载上限还没撑出滚动条, 让用户接管
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS,
      }),
    ).toBe(false);
  });

  it('returns false when attemptCount exceeds maxAttempts', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS + 10,
      }),
    ).toBe(false);
  });

  // ── 自定义 maxAttempts ──
  it('respects custom maxAttempts (e.g. tighter cap for debug)', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 1,
        maxAttempts: 1,
      }),
    ).toBe(false); // 1 >= 1, 已经到 cap
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
        maxAttempts: 1,
      }),
    ).toBe(true); // 0 < 1, 还能再来一次
  });

  // ── 短路顺序 / 多条件组合 ──
  it('returns false when scrollable AND loading (any single fail short-circuits)', () => {
    // 即便其它条件成立, 任一 fail 都得返回 false
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 22189,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: true,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('returns false when no more history AND attempts exhausted (compound fail)', () => {
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: false,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS,
      }),
    ).toBe(false);
  });

  // ── 典型场景锚点 (回归锁) ──
  it('short session with DB history (few render items, scrollH=clientH) → should fire', () => {
    // 触发 case: 渲染单元少(例如全是单 chip 折叠的 tool_segment), contentH ~500px <
    // viewport, scrollH=clientH 恰好相等, DB 还有更老的可拉.
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(true);
  });

  it('long session (already scrollable) → must not fire', () => {
    // scrollH=22189 远 > clientH=1354, 用户可手动滚, 不需要自动拉
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 22189,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('short session without DB history (new session) → must not fire', () => {
    // 新建会话 / 已经拉到 DB 顶, hasMoreMessages=false: 拉了也是空, 浪费 IPC
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: false,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(false);
  });

  it('after max fired loads still not scrollable → cutoff (degenerate session safety)', () => {
    // 模拟极端 case: 全 tool_result 折叠, 拉到上限 contentH 仍不增长, 要停手
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS,
      }),
    ).toBe(false);
  });
});

describe('shouldAutoExpandRenderWindow', () => {
  // ── 基础正向 ──
  it('returns true when not scrollable AND render-window not at top of memory', () => {
    // U1 case 漏掉的关键: load 拉回来 N 条消息但 visibleRenderItems 锚点没动,
    // slice(-INITIAL_ITEMS) 把新 prepend 出来的 render-item 切在外面 →
    // visible<total, windowAtTop=false. 应该先扩 render-window 让新 prepend 的
    // item 进 DOM, 而不是再去拉 DB.
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(true);
  });

  // ── 各单条件失败 ──
  it('returns false when viewport already scrollable (scrollH > clientH)', () => {
    // 长会话 / expand 之后内容超过 viewport: 用户可手动滚到顶, 不需要自动扩
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(false);
  });

  it('returns false when render-window already at top of memory (windowAtTop=y)', () => {
    // 内存里没有未显示的消息了 — 要靠 DB load (Stage 2), 不是 expand
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
      }),
    ).toBe(false);
  });

  it('returns false when both: scrollable AND windowAtTop (no work to do)', () => {
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: true,
      }),
    ).toBe(false);
  });

  // ── 二段式分流锚点 ──
  it('after one DB load (visible<total, windowAtTop=false) → expand needed (NOT another load)', () => {
    // 触发场景: 第一次 onLoadMore prepend N 条消息进 messages 后, allRenderItems
    // 增长但 firstVisibleItemKey 锚点没变, visibleRenderItems.slice(-INITIAL_ITEMS)
    // 还是末尾 INITIAL_ITEMS 个, visible 卡住, total>visible, windowAtTop=false.
    // 这一刻必须先扩 render-window 把新 prepend 进来的纳入视图, 不能继续走 load
    // — 否则会在"render-window 切掉新内容 → contentH 不增长 → 又 load"的循环里
    // 烧掉 IPC 配额而 contentH 始终不变.
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(true);
  });

  it('terminates when expanded enough to make scrollable', () => {
    // 期望终态: expand 一次后 contentH 撑过 viewport, scrollH > clientH,
    // 不该再 expand (用户接管手动滚)
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1500,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(false);
  });

  // ── sub-pixel 容差 ──
  it('treats scrollH = clientH + 1 as no-scroll (sub-pixel tolerance)', () => {
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1355,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(true);
  });

  it('treats scrollH = clientH + 2 as scrollable (just past tolerance)', () => {
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1356,
        clientHeight: 1354,
        windowAtTop: false,
      }),
    ).toBe(false);
  });
});

describe('decideAutoFillAction (二段式编排)', () => {
  // 这组测试专门防止"先 expand 再 load"的顺序写错或漏调一段。
  // 早期实现 caller 直接调 shouldAutoLoadMoreHistory 漏掉 Stage 1, helper 各自
  // 单测全绿但组合层烧完自动补载预算仍死锁; 这组组合测试是补这个 gap.

  // ── 退出态 ──
  it("returns 'none' when viewport already scrollable", () => {
    // 长会话: 用户手动滚, 不需要任何自动操作
    expect(
      decideAutoFillAction({
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('none');
  });

  it("returns 'none' when window covers all memory AND DB exhausted", () => {
    // 全部历史已加载完毕, 真终态
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: false,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('none');
  });

  // ── Stage 1 优先级 (核心防回归) ──
  it("returns 'expand-window' when window not at top, even if hasMore + load-eligible", () => {
    // 这是早期 bug 的核心场景: 同时满足 expand 和 load 条件, 必须优先 expand.
    // 漏掉 Stage 1 直接走 load 会让 prepend 进来的内容被 slice 切掉, 死锁.
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('expand-window');
  });

  // ── Stage 2 触发 ──
  it("returns 'load-from-db' when window at top AND load-eligible", () => {
    // 内存全显 + DB 还有 + 不在 loading + 未达 cap
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('load-from-db');
  });

  // ── Cap 行为 ──
  it("returns 'expand-window' even at attempt cap when window not at top (Stage 1 has no cap)", () => {
    // 退化保护边界: Stage 2 cap 后, Stage 1 仍允许扩 — 这能消化最后一次 load
    // 带回的 prepend, 让用户至少能看到那部分.
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS,
      }),
    ).toBe('expand-window');
  });

  it("returns 'none' at attempt cap with windowAtTop (Stage 2 capped, no further work)", () => {
    // 退化保护终态: load 预算烧完 + 内存全显 → 完全停手, 让用户接管.
    // 不会无限循环 (effect deps 没变就不再 fire).
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: MAX_AUTO_LOAD_ATTEMPTS,
      }),
    ).toBe('none');
  });

  // ── isLoadingMore 阻塞 ──
  it("returns 'none' while a load is in flight even if window at top + hasMore", () => {
    // IPC race 保护: 上一批还没回来, 不要重入.
    // (Stage 1 不需要等 loading, 因为 expand 是纯前端, 但 windowAtTop=true 时
    // Stage 1 自己拦掉)
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: true,
        attemptCount: 0,
      }),
    ).toBe('none');
  });

  it("returns 'expand-window' even while loading if window not at top", () => {
    // 微妙: load 在路上, 但 render-window 还能 expand 把已在内存的 prepend 显
    // 出来 — Stage 1 不依赖 loading 状态, 该扩就扩.
    expect(
      decideAutoFillAction({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: true,
        attemptCount: 0,
      }),
    ).toBe('expand-window');
  });

  // ── 二段式 trace 序列 (回归锁, 短 session DB 还能拉的退化场景) ──
  // 模拟 render-item 少 + DB 还有更老的 session, 走完整二段式直到撑出滚动条:
  //   step1: load → step2: load → step3: expand → step4: load → terminal: none
  // 锁住每一步的预期 action, 防止顺序写错或漏一段.
  // (visible / total 数值是 render-item 单位)
  describe('two-stage trace replay (short session deadlock recovery)', () => {
    it('step 1 — initial state (all items visible) → load', () => {
      expect(
        decideAutoFillAction({
          scrollHeight: 1354,
          clientHeight: 1354,
          windowAtTop: true, // visibleRenderItems.length === allRenderItems.length
          hasMoreMessages: true,
          isLoadingMore: false,
          attemptCount: 1,
        }),
      ).toBe('load-from-db');
    });

    it('step 2 — after load 1 (visible items still cover total) → load', () => {
      // 第一次 load 拿回 N 条消息, build 后 allRenderItems 增长但仍 ≤ INITIAL_ITEMS,
      // slice(-INITIAL_ITEMS) 仍覆盖全部. windowAtTop=y.
      expect(
        decideAutoFillAction({
          scrollHeight: 1354,
          clientHeight: 1354,
          windowAtTop: true,
          hasMoreMessages: true,
          isLoadingMore: false,
          attemptCount: 1,
        }),
      ).toBe('load-from-db');
    });

    it('step 3 — after load 2 (visibleItems < allItems) → expand (NOT load!)', () => {
      // 这一步是 bug 真因: 旧实现继续 load, 新二段式正确返 expand.
      // visibleRenderItems.length < allRenderItems.length → windowAtTop=false.
      expect(
        decideAutoFillAction({
          scrollHeight: 1354,
          clientHeight: 1354,
          windowAtTop: false,
          hasMoreMessages: true,
          isLoadingMore: false,
          attemptCount: 2,
        }),
      ).toBe('expand-window');
    });

    it('step 4 — after expand (visibleItems === allItems again) → load', () => {
      // expand 把 render-window 扩大, windowAtTop 重新 true. 该 load 了.
      expect(
        decideAutoFillAction({
          scrollHeight: 1354,
          clientHeight: 1354,
          windowAtTop: true,
          hasMoreMessages: true,
          isLoadingMore: false,
          attemptCount: 2,
        }),
      ).toBe('load-from-db');
    });

    it('terminal — scrollH grew past clientH → done', () => {
      // 期望最终态: 经过若干轮 expand+load 后, contentH 撑出 viewport, 结束.
      expect(
        decideAutoFillAction({
          scrollHeight: 1500,
          clientHeight: 1354,
          windowAtTop: true,
          hasMoreMessages: true,
          isLoadingMore: false,
          attemptCount: 3,
        }),
      ).toBe('none');
    });
  });

  // ── 子像素容差贯通: 编排函数的两段都要遵守容差 ──
  it("scrollH = clientH + 1 with windowAtTop=false → 'expand-window' (tolerance applies to Stage 1)", () => {
    expect(
      decideAutoFillAction({
        scrollHeight: 1355,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('expand-window');
  });

  it("scrollH = clientH + 1 with windowAtTop=true → 'load-from-db' (tolerance applies to Stage 2)", () => {
    expect(
      decideAutoFillAction({
        scrollHeight: 1355,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('load-from-db');
  });

  it("scrollH = clientH + 2 → 'none' (just past tolerance, treat as scrollable)", () => {
    expect(
      decideAutoFillAction({
        scrollHeight: 1356,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe('none');
  });

  // ── NO_SCROLL_TOLERANCE_PX 常量本身 ──
  it('NO_SCROLL_TOLERANCE_PX is 1 (matches sub-pixel rounding bound)', () => {
    // 锁住容差值; 改大 → 短 session 误触发概率上升; 改小到 0 → DPR≠1 死锁复发.
    expect(NO_SCROLL_TOLERANCE_PX).toBe(1);
  });

  it('MAX_AUTO_LOAD_ATTEMPTS is 5 (bounded automatic first-paint recovery)', () => {
    expect(MAX_AUTO_LOAD_ATTEMPTS).toBe(5);
  });
});

describe('decideUserIntentFillAction', () => {
  it("returns 'load-from-db' when user asks for older history after auto budget stopped", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('load-from-db');
  });

  it("returns 'expand-window' before DB load when memory window still has older items", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('expand-window');
  });

  it("returns 'none' while a DB load is already in flight", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: true,
      }),
    ).toBe('none');
  });

  it("returns 'none' when there is no older DB history", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: false,
        isLoadingMore: false,
      }),
    ).toBe('none');
  });

  it("returns 'none' when scrollable and the viewport is away from the top", () => {
    // 可滚 + 停在列表中段:上滚会产生 scroll 事件走 handleScroll,意图兜底不越权
    expect(
      decideUserIntentFillAction({
        scrollTop: 500,
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('none');
  });

  // ── 停顶兜底(2026-07 用户实报:快速滑到顶后再上滚不加载,需下滚一下再上) ──
  // 场景:容器可滚,但用户已停在 scrollTop=0 —— wheel 上滚不再产生 scroll 事件,
  // handleScroll 帮不上忙,必须由意图兜底接住。
  it("returns 'load-from-db' when scrollable but parked at the very top with more history", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('load-from-db');
  });

  it("returns 'expand-window' when scrollable and parked at top with unrendered items in memory", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: false,
        hasMoreMessages: true,
        isLoadingMore: false,
      }),
    ).toBe('expand-window');
  });

  it("returns 'none' when parked at top while a load is in flight", () => {
    expect(
      decideUserIntentFillAction({
        scrollTop: 0,
        scrollHeight: 22189,
        clientHeight: 1354,
        windowAtTop: true,
        hasMoreMessages: true,
        isLoadingMore: true,
      }),
    ).toBe('none');
  });

  it('treats scrollTop just inside / outside TOP_HISTORY_TRIGGER_PX as parked / not parked', () => {
    const base = {
      scrollHeight: 22189,
      clientHeight: 1354,
      windowAtTop: true,
      hasMoreMessages: true,
      isLoadingMore: false,
    };
    expect(
      decideUserIntentFillAction({ ...base, scrollTop: TOP_HISTORY_TRIGGER_PX - 1 }),
    ).toBe('load-from-db');
    expect(
      decideUserIntentFillAction({ ...base, scrollTop: TOP_HISTORY_TRIGGER_PX }),
    ).toBe('none');
  });

  it('TOP_HISTORY_TRIGGER_PX is 50 (matches handleScroll top-trigger threshold)', () => {
    expect(TOP_HISTORY_TRIGGER_PX).toBe(50);
  });
});
