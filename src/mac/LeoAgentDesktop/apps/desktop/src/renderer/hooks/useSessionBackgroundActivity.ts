/**
 * useSessionBackgroundActivity —— 会话「turn 已结束但 CC 子进程仍在调模型」
 * (后台子 agent 等)的响应式状态 + 一键全停动作。
 *
 * 数据源:main 侧 claude-session-background-activity(loopback proxy 的
 * per-session API 活动信号)。挂载 / 切会话时先拉一次快照(避免错过挂载前的
 * 翻转广播),随后靠 push 增量维护;全停走 stopSessionBackgroundTasks(main
 * 关闭常驻 CC 子进程,会话可续),成功后本地立即熄灭,广播到达时幂等校正。
 */

import { useCallback, useEffect, useState } from 'react';

export function useSessionBackgroundActivity(sessionId: string | undefined): {
  active: boolean;
  stopping: boolean;
  stopAll: () => Promise<void>;
} {
  const [active, setActive] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    setActive(false);
    if (!sessionId) return;
    const api = window.electronAPI?.maker;
    if (!api?.getSessionBackgroundActivity) return;
    let disposed = false;
    void api
      .getSessionBackgroundActivity(sessionId)
      .then((snap) => {
        if (!disposed) setActive(snap.active);
      })
      .catch(() => {
        // maker 未 init 等瞬态:保持 false,push 到达时校正。
      });
    const off = api.onSessionBackgroundActivityChanged((payload) => {
      if (payload.sessionId === sessionId) setActive(payload.active);
    });
    return () => {
      disposed = true;
      off();
    };
  }, [sessionId]);

  const stopAll = useCallback(async () => {
    if (!sessionId) return;
    const api = window.electronAPI?.maker;
    if (!api?.stopSessionBackgroundTasks) return;
    setStopping(true);
    try {
      await api.stopSessionBackgroundTasks(sessionId);
      setActive(false);
    } catch {
      // 关闭失败时不伪造已停止状态，继续由后台活动 push / turn 事件校正。
    } finally {
      setStopping(false);
    }
  }, [sessionId]);

  return { active, stopping, stopAll } as const;
}
