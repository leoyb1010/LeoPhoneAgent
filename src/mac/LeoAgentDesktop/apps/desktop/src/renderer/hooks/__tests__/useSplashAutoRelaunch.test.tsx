// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkEnvironment: vi.fn(async () => undefined),
  autoRelaunchToUpdate: vi.fn<
    (theme: 'light' | 'dark') => Promise<{ accepted: boolean; blockReason?: string }>
  >(async () => ({ accepted: false, blockReason: 'busy' })),
  relaunchToUpdate: vi.fn(),
}));

vi.mock('@/contexts/EnvCheckContext', () => ({
  useEnvCheck: () => ({
    status: 'update_done',
    downloadProgress: 100,
    downloadInfo: { progress: 100 },
    updateVersion: '0.0.65',
    step: undefined,
    totalSteps: undefined,
    resetSignal: 0,
    checkEnvironment: mocks.checkEnvironment,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isInitializing: false }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({ errorCode: undefined }),
}));

import { useSplash } from '../useSplash';

describe('useSplash startup auto relaunch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.checkEnvironment.mockClear();
    mocks.autoRelaunchToUpdate.mockReset();
    mocks.autoRelaunchToUpdate.mockResolvedValue({ accepted: false, blockReason: 'busy' });
    mocks.relaunchToUpdate.mockClear();
    (
      window as unknown as {
        electronAPI: {
          autoRelaunchToUpdate: typeof mocks.autoRelaunchToUpdate;
          relaunchToUpdate: typeof mocks.relaunchToUpdate;
        };
      }
    ).electronAPI = {
      autoRelaunchToUpdate: mocks.autoRelaunchToUpdate,
      relaunchToUpdate: mocks.relaunchToUpdate,
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses the guarded IPC and leaves the restart splash when main defers', async () => {
    const { result } = renderHook(() => useSplash());
    expect(result.current.phase).toBe('splash_update_done');

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(mocks.autoRelaunchToUpdate).toHaveBeenCalledWith('light');
    expect(mocks.relaunchToUpdate).not.toHaveBeenCalled();
    expect(mocks.checkEnvironment).toHaveBeenCalledTimes(1);
  });

  it('does not restart the startup checks after main accepts the relaunch', async () => {
    mocks.autoRelaunchToUpdate.mockResolvedValue({ accepted: true });
    renderHook(() => useSplash());

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(mocks.autoRelaunchToUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.checkEnvironment).not.toHaveBeenCalled();
  });

  it('holds the update relaunch until the 3s splash display floor elapses', async () => {
    // 热更路径不许绕过 MIN_DISPLAY_MS(3s)地板:update_done 在挂载即达时,
    // relaunch 延时 = max(提示最短 1.5s, 地板剩余 3s) = 3s。
    mocks.autoRelaunchToUpdate.mockResolvedValue({ accepted: true });
    renderHook(() => useSplash());

    await act(async () => {
      vi.advanceTimersByTime(2_999);
      await Promise.resolve();
    });
    expect(mocks.autoRelaunchToUpdate).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.autoRelaunchToUpdate).toHaveBeenCalledTimes(1);
  });
});
