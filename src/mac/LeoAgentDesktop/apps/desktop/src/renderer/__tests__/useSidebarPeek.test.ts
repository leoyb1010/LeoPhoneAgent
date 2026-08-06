// @vitest-environment jsdom

/**
 * useSidebarPeek.test.tsx
 * ---------------------------------------------------------------------------
 * 左侧栏「完全隐藏态 hover 临时浮出(peek)」状态机的行为覆盖:
 * - hover intent:悬停触发钮 120ms 内离开不浮出;
 * - 完整链路:peeking → 离开宽限 160ms → peekClosing → 200ms → idle;
 * - 抽屉/触发钮之间移动不误收(drawerEnter 取消、relatedTarget 命中触发钮不收);
 * - pin:peek 中 isCollapsed 翻 false → pinning 冻结 300ms → idle;
 * - hoverLock:收起动作自动上锁,指针离开触发钮(或全局移动落点不在触发钮)解锁;
 * - 全局 pointermove 兜底与窗口失焦收回;
 * - enabled=false / 非收起态的重置与 no-op。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PEEK_CLOSE_ANIM_MS,
  PEEK_CLOSE_GRACE_MS,
  PEEK_OPEN_DELAY_MS,
  PEEK_PIN_FREEZE_MS,
  useSidebarPeek,
} from '../hooks/useSidebarPeek';

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** 造一个挂在 body 上、带任意属性的元素(relatedTarget / pointermove 落点用)。 */
function makeElement(attr?: string): HTMLElement {
  const el = document.createElement('div');
  if (attr) el.setAttribute(attr, 'true');
  document.body.appendChild(el);
  return el;
}

function dispatchPointerMoveFrom(el: HTMLElement) {
  act(() => {
    // jsdom 无 PointerEvent 构造器;hook 运行时只读 event.target,普通 Event 即可。
    el.dispatchEvent(new Event('pointermove', { bubbles: true }));
  });
}

function setup(initial: { isCollapsed: boolean; enabled: boolean } = { isCollapsed: true, enabled: true }) {
  return renderHook((props: { isCollapsed: boolean; enabled: boolean }) => useSidebarPeek(props), {
    initialProps: initial,
  });
}

describe('useSidebarPeek', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hover intent:悬停不足 120ms 离开触发钮不浮出', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS - 20);
    act(() => result.current.triggerProps.onMouseLeave());
    advance(1000);
    expect(result.current.peekState).toBe('idle');
  });

  it('完整链路:悬停 120ms 浮出;离开抽屉后经宽限 → peekClosing → idle', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');
    expect(result.current.isPeekVisible).toBe(true);

    act(() => result.current.drawerProps.onMouseLeave({ relatedTarget: null } as unknown as React.MouseEvent<HTMLElement>));
    advance(PEEK_CLOSE_GRACE_MS);
    expect(result.current.peekState).toBe('peekClosing');
    advance(PEEK_CLOSE_ANIM_MS);
    expect(result.current.peekState).toBe('idle');
    expect(result.current.isPeekVisible).toBe(false);
  });

  it('宽限期内指针进入抽屉取消收回', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    // 从触发钮移向抽屉:leave 排了收回,drawerEnter 及时取消。
    act(() => result.current.triggerProps.onMouseLeave());
    advance(PEEK_CLOSE_GRACE_MS - 40);
    act(() => result.current.drawerProps.onMouseEnter());
    advance(5000);
    expect(result.current.peekState).toBe('peeking');
  });

  it('离开抽屉但 relatedTarget 是触发钮时不收回', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    const trigger = makeElement('data-sidebar-peek-trigger');
    act(() =>
      result.current.drawerProps.onMouseLeave({ relatedTarget: trigger } as unknown as React.MouseEvent<HTMLElement>),
    );
    advance(5000);
    expect(result.current.peekState).toBe('peeking');
  });

  it('pin:peek 中 isCollapsed 翻 false → pinning 冻结 → idle', () => {
    const { result, rerender } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');

    rerender({ isCollapsed: false, enabled: true });
    expect(result.current.peekState).toBe('pinning');
    expect(result.current.isPeekVisible).toBe(true);
    advance(PEEK_PIN_FREEZE_MS);
    expect(result.current.peekState).toBe('idle');
  });

  it('hoverLock:收起动作自动上锁,离开触发钮解锁后才可再 peek', () => {
    const { result, rerender } = setup({ isCollapsed: false, enabled: true });
    // 展开 → 收起(⌘B / 折叠按钮):上锁。
    rerender({ isCollapsed: true, enabled: true });
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS + 100);
    expect(result.current.peekState).toBe('idle');

    // 指针真正离开过触发钮 → 解锁,再次悬停可浮出。
    act(() => result.current.triggerProps.onMouseLeave());
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');
  });

  it('hoverLock 第二解锁路径:全局指针移动落点不在触发钮上', () => {
    const { result, rerender } = setup({ isCollapsed: false, enabled: true });
    rerender({ isCollapsed: true, enabled: true });
    // ⌘B 收起时指针不在按钮上:任意一次落点在触发钮外的移动即解锁。
    const outside = makeElement();
    dispatchPointerMoveFrom(outside);
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');
  });

  it('peeking 期全局 pointermove 兜底:落点在交互区外收回、区内保活', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);

    // 落点在抽屉内(白名单):不收回。
    const drawer = makeElement('data-sidebar-peek-drawer');
    dispatchPointerMoveFrom(drawer);
    advance(5000);
    expect(result.current.peekState).toBe('peeking');

    // 落点在主区(白名单外):经宽限 + 动画收回。
    const outside = makeElement();
    dispatchPointerMoveFrom(outside);
    advance(PEEK_CLOSE_GRACE_MS + PEEK_CLOSE_ANIM_MS);
    expect(result.current.peekState).toBe('idle');
  });

  it('peeking 期窗口失焦立即滑出', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current.peekState).toBe('peekClosing');
    advance(PEEK_CLOSE_ANIM_MS);
    expect(result.current.peekState).toBe('idle');
  });

  it('enabled 翻 false 立即整体重置', () => {
    const { result, rerender } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');
    rerender({ isCollapsed: true, enabled: false });
    expect(result.current.peekState).toBe('idle');
  });

  it('非收起态(展开/rail)悬停触发钮 no-op', () => {
    const { result } = setup({ isCollapsed: false, enabled: true });
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS + 100);
    expect(result.current.peekState).toBe('idle');
  });

  it('滑出动画中重新悬停触发钮:120ms 后直接回到 peeking', () => {
    const { result } = setup();
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    act(() => result.current.drawerProps.onMouseLeave({ relatedTarget: null } as unknown as React.MouseEvent<HTMLElement>));
    advance(PEEK_CLOSE_GRACE_MS);
    expect(result.current.peekState).toBe('peekClosing');
    act(() => result.current.triggerProps.onMouseEnter());
    advance(PEEK_OPEN_DELAY_MS);
    expect(result.current.peekState).toBe('peeking');
    advance(5000);
    expect(result.current.peekState).toBe('peeking');
  });
});
