// @vitest-environment jsdom
/**
 * useGoalStatus 切换会话时的 state 重置(reviewer #354)。
 *
 * 关键不变量:切到新 sessionId 时,旧会话的目标必须在**本次 render 内**立即清空,
 * 不能在 async getGoalStatus 返回前把旧目标挂到新 sessionId 上——否则 GoalIndicator
 * 会拿新 sessionId 渲旧目标,pause/clear/edit 误发到错的会话。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGoalStatus } from '@/hooks/useGoalStatus';

function goal(sessionId: string, objective: string): GoalStatusPayload {
  return { sessionId, objective, status: 'active' } as unknown as GoalStatusPayload;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGoalStatus session switch', () => {
  it('clears the previous goal synchronously when sessionId changes, before the new fetch resolves', async () => {
    const goalA = goal('A', '整理 A');
    const goalB = goal('B', '整理 B');
    let resolveB: ((g: GoalStatusPayload | null) => void) | null = null;
    const getGoalStatus = vi.fn((sid: string) => {
      if (sid === 'A') return Promise.resolve(goalA);
      return new Promise<GoalStatusPayload | null>((res) => {
        resolveB = res; // B 的状态故意挂起,模拟 async 未返回的窗口
      });
    });
    const onGoalStatusChanged = vi.fn(() => () => {});
    vi.stubGlobal('window', { electronAPI: { maker: { getGoalStatus, onGoalStatusChanged } } });

    const { result, rerender } = renderHook(({ sid }) => useGoalStatus(sid), {
      initialProps: { sid: 'A' as string | null },
    });
    await act(async () => {}); // flush A 的 resolved promise
    expect(result.current).toBe(goalA);

    // 切到 B:B 的 getGoalStatus 仍挂起 —— 旧 A 目标必须立刻清掉,不得泄漏到 B。
    rerender({ sid: 'B' });
    expect(result.current).toBeNull();

    // B 返回后才显示 B 的目标。
    await act(async () => {
      resolveB?.(goalB);
    });
    expect(result.current).toBe(goalB);
  });

  it('clears the goal when sessionId becomes null', async () => {
    const goalA = goal('A', '整理 A');
    const getGoalStatus = vi.fn(() => Promise.resolve(goalA));
    const onGoalStatusChanged = vi.fn(() => () => {});
    vi.stubGlobal('window', { electronAPI: { maker: { getGoalStatus, onGoalStatusChanged } } });

    const { result, rerender } = renderHook(({ sid }) => useGoalStatus(sid), {
      initialProps: { sid: 'A' as string | null },
    });
    await act(async () => {});
    expect(result.current).toBe(goalA);

    rerender({ sid: null });
    expect(result.current).toBeNull();
  });
});
