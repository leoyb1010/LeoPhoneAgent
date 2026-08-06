/**
 * useRemoteMediaErrorRetry — 远程媒体加载失败的自愈重试 state。
 * ---------------------------------------------------------------------------
 * 远程(device-link)会话里 cindy-remote-media:// 的取件失败常是被控端的瞬态
 * 窗口:典型场景是控制端发图后立即渲染,而被控端还差几秒才把 OSS 附件物化
 * 进媒体总仓(media:fetch ENOENT)——同 URL 稍后就能取到。此前 <img> 一次
 * onError 就把丢失占位固化到组件卸载,竞态窗口一过也不恢复(手机版有
 * remoteMediaResolveQueue 的负缓存 + forceRefresh 自愈,桌面控制端缺同类层)。
 *
 * 行为:错误态跟随 src 重置;src 是远程媒体时,失败后按 2s/4s/8s 退避清除
 * 错误态触发重挂载重取(502 无缓存头,不会命中 HTTP 缓存),共 3 次(累计
 * 14s,覆盖实测 ~7s 的被控端物化窗口);仍失败停在丢失占位,交用户手动刷新。
 * 本机 scheme 的失败(文件真没了)不重试,与既有行为一致。
 */

import { useEffect, useState } from 'react';
import { isRemoteMediaUrl } from '../../shared/remoteMediaUrl';

export const REMOTE_MEDIA_RETRY_MAX = 3;
export const REMOTE_MEDIA_RETRY_BASE_MS = 2000;

export function useRemoteMediaErrorRetry(src: string): {
  errored: boolean;
  onLoadError: () => void;
} {
  const [errored, setErrored] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  // 错误态必须跟随可展示资源重置:远程会话首帧可能先用本机地址渲染并
  // onError,随后 deviceId/远程媒体引用就位后 src 才变成 cindy-remote-media://。
  useEffect(() => {
    setErrored(false);
    setRetryCount(0);
  }, [src]);
  useEffect(() => {
    if (!errored || retryCount >= REMOTE_MEDIA_RETRY_MAX || !isRemoteMediaUrl(src)) {
      return;
    }
    const timer = setTimeout(() => {
      setRetryCount((count) => count + 1);
      setErrored(false);
    }, REMOTE_MEDIA_RETRY_BASE_MS * 2 ** retryCount);
    return () => clearTimeout(timer);
  }, [errored, retryCount, src]);
  return { errored, onLoadError: () => setErrored(true) };
}
