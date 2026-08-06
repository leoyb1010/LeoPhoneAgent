// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRunNowBusyGuard } from '../useRunNowBusyGuard';

/**
 * 回归：runNow 的 busy 守卫必须在 run **派发**(‘fired’)时释放,而不是等 run 跑完
 * (schedule.runNow 的 IPC 要等整个 run 结束才 resolve)。否则「立即运行」按钮会在整个
 * run 期间卡在 disabled + 半透明,永不消失(见 useRunNowBusyGuard 头注)。
 */

type ScheduleEventCb = (ev: unknown) => void;

let listeners: ScheduleEventCb[];
let unsubscribeCalls: number;

function emit(ev: unknown): void {
  act(() => {
    listeners.forEach((cb) => cb(ev));
  });
}

function stubScheduleEventApi(): void {
  listeners = [];
  unsubscribeCalls = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      schedule: {
        onEvent: (cb: ScheduleEventCb) => {
          listeners.push(cb);
          return () => {
            unsubscribeCalls += 1;
            listeners = listeners.filter((l) => l !== cb);
          };
        },
      },
    },
  };
}

describe('useRunNowBusyGuard', () => {
  beforeEach(() => {
    stubScheduleEventApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('begin 标记 busy,重复 begin 返回 false(防双发)', () => {
    const { result } = renderHook(() => useRunNowBusyGuard());

    let first = false;
    let second = false;
    act(() => {
      first = result.current.begin('a');
    });
    act(() => {
      second = result.current.begin('a');
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // 派发窗口内不允许再次触发同一 schedule
    expect(result.current.busyIds.has('a')).toBe(true);
  });

  it("'fired' 事件(run 已派发)立即释放 busy —— 不等 run 结束", () => {
    const { result } = renderHook(() => useRunNowBusyGuard());
    act(() => {
      result.current.begin('a');
    });
    expect(result.current.busyIds.has('a')).toBe(true);

    emit({ type: 'fired', scheduleId: 'a', runId: 'r1' });

    expect(result.current.busyIds.has('a')).toBe(false);
    // 释放后应允许再次触发(runNow 是 force-fire,fire 后本就允许并发)
    let again = false;
    act(() => {
      again = result.current.begin('a');
    });
    expect(again).toBe(true);
  });

  it.each(['completed', 'failed', 'deferred', 'skipped'] as const)(
    "终态事件 '%s' 也释放 busy(兜住不经 'fired' 的分支)",
    (type) => {
      const { result } = renderHook(() => useRunNowBusyGuard());
      act(() => {
        result.current.begin('a');
      });
      emit({ type, scheduleId: 'a', runId: 'r1', sessionId: '', error: 'x' });
      expect(result.current.busyIds.has('a')).toBe(false);
    },
  );

  it('无关事件不释放 busy,且只释放事件对应的 schedule', () => {
    const { result } = renderHook(() => useRunNowBusyGuard());
    act(() => {
      result.current.begin('a');
      result.current.begin('b');
    });

    // 'session-bound' / 'changed' 等不属于「已派发 / 终态」,不应释放
    emit({ type: 'session-bound', scheduleId: 'a', runId: 'r1', sessionId: 's1' });
    emit({ type: 'changed', scheduleId: 'a' });
    expect(result.current.busyIds.has('a')).toBe(true);

    // 只释放事件里 scheduleId 命中的那条
    emit({ type: 'fired', scheduleId: 'a', runId: 'r1' });
    expect(result.current.busyIds.has('a')).toBe(false);
    expect(result.current.busyIds.has('b')).toBe(true);
  });

  it('release 兜底手动清除(fire 前抛错路径)', () => {
    const { result } = renderHook(() => useRunNowBusyGuard());
    act(() => {
      result.current.begin('a');
    });
    act(() => {
      result.current.release('a');
    });
    expect(result.current.busyIds.has('a')).toBe(false);
  });

  it('卸载时取消事件订阅', () => {
    const { unmount } = renderHook(() => useRunNowBusyGuard());
    expect(listeners.length).toBe(1);
    unmount();
    expect(unsubscribeCalls).toBe(1);
    expect(listeners.length).toBe(0);
  });
});
