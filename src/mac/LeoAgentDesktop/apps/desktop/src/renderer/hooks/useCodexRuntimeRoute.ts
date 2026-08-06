import { useEffect, useState } from 'react';

export type CodexAuthInjection = 'oauth-bearer' | 'env-key' | 'provider-oauth';

export interface CodexRuntimeRoute {
  authInjection: CodexAuthInjection;
}

/**
 * useCodexRuntimeRoute — 读取 Codex app-server 当前进程启动时冻结的实际路由。
 *
 * 这个值和当前登录态不同: 用户可以在 env-key host 启动后再登录 OAuth,运行中的
 * host 仍然走 gateway。右下角用量 chip 必须按这个 runtime route 显示订阅/API 形态。
 */
export function useCodexRuntimeRoute(options?: { enabled?: boolean; refreshKey?: unknown }) {
  const enabled = options?.enabled ?? true;
  const refreshKey = options?.refreshKey;
  const [route, setRoute] = useState<CodexRuntimeRoute>({
    authInjection: 'env-key',
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    window.electronAPI.maker
      .codexRuntimeRouteGet()
      .then((next) => {
        if (!cancelled) setRoute(next);
      })
      .catch(() => {
        /* keep conservative env-key default */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    return window.electronAPI.maker.onCodexRuntimeRouteChanged((next) => {
      setRoute(next);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== 'codex') return;
      window.electronAPI.maker
        .codexRuntimeRouteGet()
        .then((next) => {
          if (!cancelled) setRoute(next);
        })
        .catch(() => {
          /* keep current route */
        });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);

  return route;
}
