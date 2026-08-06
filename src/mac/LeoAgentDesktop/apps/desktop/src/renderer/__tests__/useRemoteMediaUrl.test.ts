// @vitest-environment jsdom
/**
 * useRemoteMediaUrl.test.ts — 远程会话媒体 URL 改写 hook 契约。
 * 远程会话(context origin = device)→ 媒体 URL 改写到 cindy-remote-media://;
 * 本地会话 / 非媒体 URL / provider 之外 → 原样。
 *
 * deviceId 订阅已收敛到 ChatSessionFileContext 的 provider(MessageStream 顶层),
 * hook 本身只消费 context —— 所以这里用真 provider(useChatSessionFileValue,
 * 底下是 mock 的 remoteProjectsStore)组装测试环境,origin-injection race 的
 * 重算路径也经由 provider 验证。
 */
import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getSessionDeviceId = vi.hoisted(() => vi.fn());
const subscribe = vi.hoisted(() => vi.fn());
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId,
  remoteProjectsStore: { subscribe },
}));

import { useRemoteMediaUrl } from '../hooks/useRemoteMediaUrl';
import {
  ChatSessionFileProvider,
  useChatSessionFileValue,
} from '../components/chat/ChatSessionFileContext';

/** 捕获 useSyncExternalStore 注册的 onStoreChange,便于在测试里模拟「store 变更」触发重算。 */
let storeListener: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  storeListener = null;
  subscribe.mockImplementation((cb: () => void) => {
    storeListener = cb;
    return () => {
      storeListener = null;
    };
  });
});

/** 聊天流同款环境:provider 值由 useChatSessionFileValue 订阅式构造。 */
function Provider({ children }: { children: ReactNode }) {
  const value = useChatSessionFileValue('sess-1', '/wd', null);
  return React.createElement(ChatSessionFileProvider, { value, children });
}

/** SSH 远程会话环境:remoteHostId 非空(deviceId 不注册)。 */
function SshProvider({ children }: { children: ReactNode }) {
  const value = useChatSessionFileValue('sess-1', '/remote/wd', 'host-1');
  return React.createElement(ChatSessionFileProvider, { value, children });
}

describe('useRemoteMediaUrl', () => {
  it('远程会话 + 媒体 URL → 改写到 cindy-remote-media://', () => {
    getSessionDeviceId.mockReturnValue('dev-1');
    const { result } = renderHook(() => useRemoteMediaUrl('xdt-image://s/a.png', 'sess-1'), {
      wrapper: Provider,
    });
    expect(result.current.startsWith('cindy-remote-media://')).toBe(true);
    expect(getSessionDeviceId).toHaveBeenCalledWith('sess-1');
  });

  it('本地会话(getSessionDeviceId → undefined)→ 原样', () => {
    getSessionDeviceId.mockReturnValue(undefined);
    const { result } = renderHook(() => useRemoteMediaUrl('xdt-image://s/a.png', 'sess-1'), {
      wrapper: Provider,
    });
    expect(result.current).toBe('xdt-image://s/a.png');
  });

  it('无 sessionId 参数 → 即便 context 是远程会话也原样(调用方未声明会话归属)', () => {
    getSessionDeviceId.mockReturnValue('dev-1');
    const { result } = renderHook(() => useRemoteMediaUrl('xdt-image://s/a.png', undefined), {
      wrapper: Provider,
    });
    expect(result.current).toBe('xdt-image://s/a.png');
  });

  it('provider 之外(聊天流外复用)→ 不查 store,原样', () => {
    const { result } = renderHook(() => useRemoteMediaUrl('xdt-image://s/a.png', 'sess-1'));
    expect(result.current).toBe('xdt-image://s/a.png');
    expect(getSessionDeviceId).not.toHaveBeenCalled();
  });

  it('远程会话但非媒体 URL(http)→ 原样', () => {
    getSessionDeviceId.mockReturnValue('dev-1');
    const { result } = renderHook(() => useRemoteMediaUrl('https://x/y.png', 'sess-1'), {
      wrapper: Provider,
    });
    expect(result.current).toBe('https://x/y.png');
  });

  it('ssh 会话:workdir 内 xdt-file path URL → 改写;cache-id xdt-image → 原样(占位语义)', () => {
    getSessionDeviceId.mockReturnValue(undefined);
    const fileUrl = 'xdt-file://local/?path=%2Fremote%2Fwd%2Fout%2Fa.bin';
    const { result: fileRes } = renderHook(() => useRemoteMediaUrl(fileUrl, 'sess-1'), {
      wrapper: SshProvider,
    });
    expect(fileRes.current.startsWith('cindy-remote-media://')).toBe(true);

    const { result: imgRes } = renderHook(
      () => useRemoteMediaUrl('xdt-image://s/a.png', 'sess-1'),
      { wrapper: SshProvider },
    );
    expect(imgRes.current).toBe('xdt-image://s/a.png');
  });

  it('origin-injection race:首渲 deviceId 未就位(原样)→ store 补上 deviceId 后重算改写', () => {
    // 首渲时 sessionId→deviceId 尚未注册(消息先到、setDeviceSessions 后落)。
    getSessionDeviceId.mockReturnValue(undefined);
    const { result } = renderHook(() => useRemoteMediaUrl('xdt-image://s/a.png', 'sess-1'), {
      wrapper: Provider,
    });
    expect(result.current).toBe('xdt-image://s/a.png'); // 还停在本机 URL

    // store 落地 deviceId 并通知:provider 订阅了 store → context 更新 → hook 重算改写。
    act(() => {
      getSessionDeviceId.mockReturnValue('dev-1');
      storeListener?.();
    });
    expect(result.current.startsWith('cindy-remote-media://')).toBe(true);
  });
});
