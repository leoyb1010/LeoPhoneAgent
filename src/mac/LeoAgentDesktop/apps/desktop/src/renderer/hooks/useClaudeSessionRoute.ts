import { useEffect, useState } from 'react';

export type ClaudeSessionBillingRoute = 'gateway' | 'subscription';

/**
 * useClaudeSessionRoute — cc 默认路由会话的「生效计费路由」(proxy 按请求观察的真值)。
 *
 * 返回 null = 未观察到(会话尚未发过请求 / app 重启后未活动 / enabled=false),此时
 * 消费方回落活性凭证启发式 —— 新会话的下一次 spawn 恰按当前凭证决定, 启发式即正确
 * 预测;而已发过请求的会话以观察值为准, 不受「spawn 后凭证变化」影响(child 凭证
 * 在 spawn 时冻结, 全局活性状态重算会与实际路由发散)。
 *
 * mount 时 GET 一次, 此后跟随 CLAUDE_SESSION_ROUTE_CHANGED push(按 sessionId 过滤)。
 */
export function useClaudeSessionRoute(
  sessionId: string | undefined,
  enabled: boolean,
): ClaudeSessionBillingRoute | null {
  const [route, setRoute] = useState<ClaudeSessionBillingRoute | null>(null);

  useEffect(() => {
    // sessionId / enabled 变化即重置 —— 上一个会话的观察值不得挂到新会话上。
    setRoute(null);
    if (!enabled || !sessionId) return undefined;
    let cancelled = false;
    void window.electronAPI.maker
      .claudeSessionRouteGet(sessionId)
      .then((value) => {
        if (!cancelled) setRoute(value);
      })
      .catch(() => {
        /* 读不到保持 null → 消费方回落启发式 */
      });
    const off = window.electronAPI.maker.onClaudeSessionRouteChanged((payload) => {
      if (payload.sessionId === sessionId) setRoute(payload.route);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, enabled]);

  return route;
}
