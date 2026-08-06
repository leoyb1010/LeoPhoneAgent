// @vitest-environment jsdom

/**
 * useRightSidebarResize 单测(B1b-1:布局树全局持久化)
 * ---------------------------------------------------------------------------
 * 覆盖:树 → fraction → width 读取链、松手/复位写回树、layout:changed 订阅刷新、
 * 旧 localStorage 键的一次性迁移(:last 迁入树 + 全量清键 + memo 幂等)。
 *
 * 拖拽 PointerEvent 流 (handleDragStart → pointermove → pointerup) 涉及 document 全局
 * listener,在 jsdom 下需要手工 dispatch 模拟,可读性差;这里测 fraction → width
 * 换算 + reset + 订阅 + 迁移,覆盖本次改造的核心点。
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLayout, findSplitChildByPanelKind, type Layout } from '../../../shared/layoutTree';
import {
  useRightSidebarResize,
  migrateLegacyRsbFraction,
  __resetRsbFractionMigrationForTests,
  RIGHT_SIDEBAR_MIN_WIDTH,
} from '../useRightSidebarResize';
import { RSB_FRACTION_KEY_PREFIX, RSB_FRACTION_LAST_KEY } from '@/lib/sessionLayoutPrefs';

/** 选 2000 让 fraction ∈ [0.1, 0.8] 不会被双侧下限 clamp(maxWidth = 2000−400 = 1600)。 */
const AVAIL = 2000;
const DEFAULT_FRACTION = 0.5;

/**
 * jsdom 自带的 localStorage 在当前 vitest 版本下实现不完整,换成带 length/key 的
 * 最小 stub(迁移逻辑要遍历全部 key,length/key 是必须的)。
 */
class MemLocalStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

/** 内存版 electronAPI.layout stub:getStateSync / set / onChanged 全链路可断言。 */
function makeLayoutApiStub(initial?: Layout) {
  let layout = initial ?? createDefaultLayout();
  const listeners = new Set<(payload: { layout: Layout }) => void>();
  const api = {
    getStateSync: vi.fn(() => ({ layout })),
    set: vi.fn(async (next: Layout) => {
      layout = next;
      for (const cb of listeners) cb({ layout });
      return { layout };
    }),
    reset: vi.fn(async () => {
      layout = createDefaultLayout();
      for (const cb of listeners) cb({ layout });
      return { layout };
    }),
    onChanged: vi.fn((cb: (payload: { layout: Layout }) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  return {
    api,
    getLayout: () => layout,
    /** 模拟外部写方(dev 工具 / 其它窗口)直接换树并广播。 */
    externalSet: (next: Layout) => {
      layout = next;
      for (const cb of listeners) cb({ layout });
    },
  };
}

/** 造一棵指定 right-tabs fraction 的树。 */
function layoutWithRightFraction(fraction: number): Layout {
  const layout = createDefaultLayout();
  const split = layout.content as Extract<Layout['content'], { type: 'split' }>;
  split.children[0].fraction = 1 - fraction;
  split.children[1].fraction = fraction;
  return layout;
}

let memStorage: MemLocalStorage;
let layoutStub: ReturnType<typeof makeLayoutApiStub>;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('localStorage', memStorage);
  layoutStub = makeLayoutApiStub();
  vi.stubGlobal('window', Object.assign(window, {}));
  (window as unknown as { electronAPI: { layout: unknown } }).electronAPI = {
    layout: layoutStub.api,
  };
  __resetRsbFractionMigrationForTests();
});

afterEach(() => {
  __resetRsbFractionMigrationForTests();
  vi.unstubAllGlobals();
});

describe('useRightSidebarResize(树驱动宽度)', () => {
  it('默认树(0.5/0.5)→ 宽度 = 0.5 × 可用宽', () => {
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBe(DEFAULT_FRACTION * AVAIL);
  });

  it('树上的 fraction 驱动首帧宽度', () => {
    layoutStub.externalSet(layoutWithRightFraction(0.3));
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBe(Math.round(0.3 * AVAIL));
  });

  it('layout:changed 广播(外部写方)→ 宽度即时刷新', () => {
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBe(DEFAULT_FRACTION * AVAIL);
    act(() => {
      layoutStub.externalSet(layoutWithRightFraction(0.7));
    });
    expect(result.current.width).toBe(Math.round(0.7 * AVAIL));
  });

  // resetWidth 已随私有把手拆除:复位语义 = 引擎分割线双击(RootDivider),
  // 由 layoutTree 的 transferSplitFraction 单测锁定,不再经本 hook。

  it('树里没有 right-tabs(单 pane content)→ 落渲染兜底默认', () => {
    const solo = createDefaultLayout();
    (solo as { content: unknown }).content = {
      type: 'pane',
      id: 'chat',
      panelKind: 'chat-main',
      minWidth: 400,
    };
    layoutStub.externalSet(solo);
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBe(DEFAULT_FRACTION * AVAIL);
  });

  it('fraction 过小时宽度 clamp 到最小宽', () => {
    // 树上 0.1(MIN_FRACTION)× 2000 = 200 < 280 → clamp 到 280。
    layoutStub.externalSet(layoutWithRightFraction(0.1));
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBeGreaterThanOrEqual(RIGHT_SIDEBAR_MIN_WIDTH);
  });

  it('把手边缘由树上位置推导:默认树(right-tabs 在右)→ left', () => {
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.resizeEdge).toBe('left');
  });

  it('交换树(right-tabs 在最左)→ 把手在 right,广播后即时跟随', () => {
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.resizeEdge).toBe('left');
    const swapped = createDefaultLayout();
    (swapped.content as { children: unknown[] }).children.reverse();
    act(() => {
      layoutStub.externalSet(swapped);
    });
    expect(result.current.resizeEdge).toBe('right');
  });

  it('树里没有 right-tabs → 边缘落默认 left', () => {
    const solo = createDefaultLayout();
    (solo as { content: unknown }).content = {
      type: 'pane',
      id: 'chat',
      panelKind: 'chat-main',
      minWidth: 400,
    };
    layoutStub.externalSet(solo);
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.resizeEdge).toBe('left');
  });
});

describe('migrateLegacyRsbFraction(旧 localStorage → 树,一次性)', () => {
  it(':last 存在 → 返回其值、清掉全部 fraction key、写树', () => {
    localStorage.setItem(RSB_FRACTION_LAST_KEY, '0.65');
    localStorage.setItem(`${RSB_FRACTION_KEY_PREFIX}session-a`, '0.4');
    localStorage.setItem(`${RSB_FRACTION_KEY_PREFIX}session-b`, '0.8');
    localStorage.setItem('unrelated-key', 'keep-me');

    const migrated = migrateLegacyRsbFraction();

    expect(migrated).toBeCloseTo(0.65);
    expect(localStorage.getItem(RSB_FRACTION_LAST_KEY)).toBeNull();
    expect(localStorage.getItem(`${RSB_FRACTION_KEY_PREFIX}session-a`)).toBeNull();
    expect(localStorage.getItem(`${RSB_FRACTION_KEY_PREFIX}session-b`)).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
    // 迁移值已写树
    const ref = findSplitChildByPanelKind(layoutStub.getLayout(), 'right-tabs');
    expect(ref?.fraction).toBeCloseTo(0.65);
  });

  it('无任何旧 key → 返回 null、不写树', () => {
    expect(migrateLegacyRsbFraction()).toBeNull();
    expect(layoutStub.api.set).not.toHaveBeenCalled();
  });

  it('只有 per-session key 没有 :last → 清键但不迁值(per-session 记忆按决策丢弃)', () => {
    localStorage.setItem(`${RSB_FRACTION_KEY_PREFIX}session-a`, '0.4');
    expect(migrateLegacyRsbFraction()).toBeNull();
    expect(localStorage.getItem(`${RSB_FRACTION_KEY_PREFIX}session-a`)).toBeNull();
    expect(layoutStub.api.set).not.toHaveBeenCalled();
  });

  it('memo 幂等:第二次调用直接吃缓存(StrictMode 双跑不会误判无旧值)', () => {
    localStorage.setItem(RSB_FRACTION_LAST_KEY, '0.65');
    expect(migrateLegacyRsbFraction()).toBeCloseTo(0.65);
    // 键已被第一次调用清掉,但 memo 仍返回迁移值
    expect(migrateLegacyRsbFraction()).toBeCloseTo(0.65);
    // 树只写一次
    expect(layoutStub.api.set).toHaveBeenCalledTimes(1);
  });

  it(':last 是非法值 → 视作无旧值,但键仍被清理', () => {
    localStorage.setItem(RSB_FRACTION_LAST_KEY, 'not-a-number');
    expect(migrateLegacyRsbFraction()).toBeNull();
    expect(localStorage.getItem(RSB_FRACTION_LAST_KEY)).toBeNull();
  });

  it(':last 超界 → clamp 进 [0.1, 0.9] 再迁移', () => {
    localStorage.setItem(RSB_FRACTION_LAST_KEY, '5');
    expect(migrateLegacyRsbFraction()).toBeCloseTo(0.9);
  });

  it('mount 时首帧直接用迁移值渲染(无「先旧后新」跳变)', () => {
    localStorage.setItem(RSB_FRACTION_LAST_KEY, '0.65');
    const { result } = renderHook(() => useRightSidebarResize(AVAIL));
    expect(result.current.width).toBe(Math.round(0.65 * AVAIL));
  });
});
