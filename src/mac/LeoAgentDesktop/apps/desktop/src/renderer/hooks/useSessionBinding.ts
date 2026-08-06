/**
 * useSessionBinding
 * ---------------------------------------------------------------------------
 * Per-sessionId 接管状态订阅 — 给 CCAgentSessionView 用来决定:
 *   - 是否渲染 ChatInput (false) vs TakeoverMask (true)
 *   - 收回按钮触发 window.electronAPI.binding.revoke(sessionId)
 *
 * 状态来源:
 *   1. 初始: mount 时 invoke binding:resolve-session 拿当前状态
 *   2. 后续: 订阅 binding:changed 广播; main 端 attach/detach 后推一次
 *
 * 路由变化 (sessionId prop 变) 自动重订阅 + 重查初始状态。
 *
 * 当 binding:changed event 携带的 sessionId 跟当前订阅的 sessionId 不匹配:
 *   - attach event: 别的 session 被接管, 不影响当前 — 但可能"我刚被接管的状态"
 *     被另一个 attach 顶替了 — 这种 case 概率极小 (一个 owner 单 binding),
 *     稳妥起见任何 binding:changed 都重新 invoke 拉一次最新状态。
 *   - detach event 同理。
 */

import { useEffect, useState } from 'react';

interface SessionBindingState {
  attached: boolean;
  /** identity 信息 — UI 显示"被 [user] 接管"用; 未 attached 时为 null */
  identity: {
    channel: string;
    botContextId: string;
    userId: string;
  } | null;
  /** Channel 上下文取的姓名 (e.g. 飞书姓名); 取不到 null, mask 自己 fallback */
  displayName: string | null;
}

const INITIAL: SessionBindingState = { attached: false, identity: null, displayName: null };

export function useSessionBinding(sessionId: string | undefined): SessionBindingState {
  const [state, setState] = useState<SessionBindingState>(INITIAL);

  useEffect(() => {
    if (!sessionId) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;

    const refresh = async () => {
      try {
        const r = await window.electronAPI.binding.resolveSession(sessionId);
        if (cancelled) return;
        setState({
          attached: r.attached,
          identity: r.identity ?? null,
          displayName: r.displayName ?? null,
        });
      } catch {
        if (cancelled) return;
        setState(INITIAL);
      }
    };

    void refresh();

    // 任何 binding:changed event 都触发一次 refresh — 无脑重拉简单可靠,
    // 频率不高 (用户级操作), 不需要按 sessionId 过滤。
    const unsubscribe = window.electronAPI.binding.onChanged(() => {
      void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return state;
}
