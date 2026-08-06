// @vitest-environment jsdom
/**
 * useRemoteMediaErrorRetry.test.ts — 远程媒体加载失败自愈重试:
 *   - 远程媒体 src 失败 → 按 2s/4s/8s 退避清除错误态(触发重挂载重取)
 *   - 重试次数用尽 → 错误态固化,不再自动清除
 *   - 本机 scheme 的失败不重试(文件真没了,重试无意义)
 *   - src 变化 → 错误态与重试计数一并重置
 *   - 卸载 → 清掉挂起的重试 timer(不泄漏)
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useRemoteMediaErrorRetry,
  REMOTE_MEDIA_RETRY_MAX,
  REMOTE_MEDIA_RETRY_BASE_MS,
} from '../useRemoteMediaErrorRetry';
import { buildRemoteMediaUrl } from '../../../shared/remoteMediaUrl';

const REMOTE_URL = buildRemoteMediaUrl(
  { kind: 'device', deviceId: 'dev-1' },
  `cindy-media://blobs/${'a'.repeat(64)}.png`,
);
const LOCAL_URL = 'xdt-image://session-1/clipboard-1.png';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRemoteMediaErrorRetry', () => {
  it('远程媒体失败 → 退避后清除错误态;三次用尽后固化', () => {
    const { result } = renderHook(() => useRemoteMediaErrorRetry(REMOTE_URL));
    expect(result.current.errored).toBe(false);

    for (let attempt = 0; attempt < REMOTE_MEDIA_RETRY_MAX; attempt++) {
      act(() => result.current.onLoadError());
      expect(result.current.errored).toBe(true);
      const delay = REMOTE_MEDIA_RETRY_BASE_MS * 2 ** attempt;
      // 退避未到点不清除
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(result.current.errored).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.errored).toBe(false);
    }

    // 第 4 次失败:额度用尽,永不自动清除
    act(() => result.current.onLoadError());
    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    expect(result.current.errored).toBe(true);
  });

  it('本机 scheme 失败 → 不重试,错误态固化', () => {
    const { result } = renderHook(() => useRemoteMediaErrorRetry(LOCAL_URL));
    act(() => result.current.onLoadError());
    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    expect(result.current.errored).toBe(true);
  });

  it('src 变化 → 错误态与重试计数重置(新地址重新有完整额度)', () => {
    const { result, rerender } = renderHook(({ src }) => useRemoteMediaErrorRetry(src), {
      initialProps: { src: LOCAL_URL },
    });
    act(() => result.current.onLoadError());
    expect(result.current.errored).toBe(true);

    rerender({ src: REMOTE_URL });
    expect(result.current.errored).toBe(false);

    // 新地址失败仍可走完整退避重试
    act(() => result.current.onLoadError());
    act(() => vi.advanceTimersByTime(REMOTE_MEDIA_RETRY_BASE_MS));
    expect(result.current.errored).toBe(false);
  });

  it('卸载 → 挂起的重试 timer 被清理', () => {
    const { result, unmount } = renderHook(() => useRemoteMediaErrorRetry(REMOTE_URL));
    act(() => result.current.onLoadError());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
