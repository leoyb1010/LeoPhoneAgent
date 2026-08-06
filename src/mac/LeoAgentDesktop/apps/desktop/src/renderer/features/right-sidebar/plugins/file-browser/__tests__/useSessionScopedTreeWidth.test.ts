// @vitest-environment jsdom

/**
 * useSessionScopedTreeWidth 单测 —— 覆盖文件树宽度的 per-session 持久化 + `:last` fallback +
 * setWidth/resetWidth 镜像。
 *
 * 跟 useRightSidebarResize.test 不同的是,这里的 hook **会**在 mount / sessionId 变化时
 * 主动把读到的值 setWidth 进内层 useHorizontalResize,内层 setWidth 会持久化到 per-session
 * key —— 即"物化 fallback 到 per-session"的语义。测试覆盖这一点。
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useSessionScopedTreeWidth,
  TREE_DEFAULT_WIDTH,
  TREE_MIN_WIDTH,
} from '../useSessionScopedTreeWidth';
import {
  RSB_TREE_WIDTH_KEY_PREFIX,
  RSB_TREE_WIDTH_LAST_KEY,
  cleanupSessionLayoutPrefs,
} from '@/lib/sessionLayoutPrefs';

const TREE_MAX_DYN = 500;

function kSession(sid: string): string {
  return `${RSB_TREE_WIDTH_KEY_PREFIX}${sid}`;
}

/** 同 useRightSidebarResize.test.ts:替换 jsdom 残缺 localStorage 为完整 stub。 */
class MemLocalStorage {
  private store = new Map<string, string>();
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

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('localStorage', memStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSessionScopedTreeWidth per-session persistence', () => {
  it('fresh session with no keys uses TREE_DEFAULT_WIDTH', () => {
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'A', dynamicTreeMax: TREE_MAX_DYN }),
    );
    expect(result.current.width).toBe(TREE_DEFAULT_WIDTH);
  });

  it('per-session key takes precedence over :last fallback', () => {
    localStorage.setItem(kSession('A'), '260');
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, '300');
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'A', dynamicTreeMax: TREE_MAX_DYN }),
    );
    expect(result.current.width).toBe(260);
  });

  it('falls back to :last when per-session missing, and materializes it via setWidth effect', () => {
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, '300');
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'B', dynamicTreeMax: TREE_MAX_DYN }),
    );
    expect(result.current.width).toBe(300);
    // setWidth effect 物化到 per-session
    expect(localStorage.getItem(kSession('B'))).toBe('300');
  });

  it('switching sessionId re-reads storage', () => {
    localStorage.setItem(kSession('A'), '180');
    localStorage.setItem(kSession('B'), '320');
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) =>
        useSessionScopedTreeWidth({ sessionId: sid, dynamicTreeMax: TREE_MAX_DYN }),
      { initialProps: { sid: 'A' } },
    );
    expect(result.current.width).toBe(180);
    rerender({ sid: 'B' });
    expect(result.current.width).toBe(320);
    rerender({ sid: 'A' });
    expect(result.current.width).toBe(180);
  });

  it('setWidth mirrors to :last', () => {
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'A', dynamicTreeMax: TREE_MAX_DYN }),
    );
    act(() => {
      result.current.setWidth(260);
    });
    expect(localStorage.getItem(kSession('A'))).toBe('260');
    expect(localStorage.getItem(RSB_TREE_WIDTH_LAST_KEY)).toBe('260');
  });

  it('resetWidth clears per-session and writes default to :last', () => {
    localStorage.setItem(kSession('A'), '260');
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, '260');
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'A', dynamicTreeMax: TREE_MAX_DYN }),
    );
    act(() => {
      result.current.resetWidth();
    });
    expect(localStorage.getItem(kSession('A'))).toBeNull();
    expect(localStorage.getItem(RSB_TREE_WIDTH_LAST_KEY)).toBe(String(TREE_DEFAULT_WIDTH));
    expect(result.current.width).toBe(TREE_DEFAULT_WIDTH);
  });

  it('subsequent fresh session inherits reset default via :last', () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) =>
        useSessionScopedTreeWidth({ sessionId: sid, dynamicTreeMax: TREE_MAX_DYN }),
      { initialProps: { sid: 'A' } },
    );
    act(() => {
      result.current.setWidth(260);
      result.current.resetWidth();
    });
    rerender({ sid: 'fresh-C' });
    expect(result.current.width).toBe(TREE_DEFAULT_WIDTH);
  });

  it('sessionId=null returns hardcoded default and skips :last fallback', () => {
    // 语义:sessionId=null 表示"非 session 状态"(MainLayout 在某些非聊天路由短暂出现),
    // 此时不读 :last 偏好——避免继承上一个用户的随手值,稳定显示默认。setWidth 时
    // wrapper 跳过 :last 镜像(没有 sessionId 无人主张这是 user intent)。
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, '300');
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: null, dynamicTreeMax: TREE_MAX_DYN }),
    );
    expect(result.current.width).toBe(TREE_DEFAULT_WIDTH);
    act(() => {
      result.current.setWidth(260);
    });
    // 不写 `:null` 这种脏 key
    expect(localStorage.getItem(`${RSB_TREE_WIDTH_KEY_PREFIX}null`)).toBeNull();
    // :last 维持 setup 时塞的 '300',wrapper 跳过镜像
    expect(localStorage.getItem(RSB_TREE_WIDTH_LAST_KEY)).toBe('300');
  });

  it('clamps to TREE_MIN_WIDTH when stored value too small', () => {
    localStorage.setItem(kSession('A'), '50');
    const { result } = renderHook(() =>
      useSessionScopedTreeWidth({ sessionId: 'A', dynamicTreeMax: TREE_MAX_DYN }),
    );
    expect(result.current.width).toBeGreaterThanOrEqual(TREE_MIN_WIDTH);
  });

  it('cleanupSessionLayoutPrefs removes per-session key but not :last', () => {
    localStorage.setItem(kSession('A'), '260');
    localStorage.setItem(RSB_TREE_WIDTH_LAST_KEY, '300');
    cleanupSessionLayoutPrefs('A');
    expect(localStorage.getItem(kSession('A'))).toBeNull();
    expect(localStorage.getItem(RSB_TREE_WIDTH_LAST_KEY)).toBe('300');
  });
});
