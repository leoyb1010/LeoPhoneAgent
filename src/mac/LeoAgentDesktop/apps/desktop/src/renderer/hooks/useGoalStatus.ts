/**
 * useGoalStatus —— 订阅某会话的 /goal 状态。
 *
 * 数据来源:挂载时 getGoalStatus 拉一次 + goal 状态 push 增量更新(按 sessionId
 * 过滤)。goal=null 表示该会话无目标 → GoalIndicator 不渲染。
 * device-link 远程会话经 goalApiFor / subscribeGoalStatusChanged 自动路由到
 * 被控端(goal-host 在会话归属设备上跑),本机会话行为不变。
 *
 * 时序遵守设计规范(规则 7):本地数据,无 loading 态;拿到前返回 null,
 * GoalIndicator 据此直接不显示,不产生空白帧。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { goalApiFor, subscribeGoalStatusChanged } from '@/lib/makerTransport';

export function useGoalStatus(sessionId: string | null | undefined): GoalStatusPayload | null {
  const [goal, setGoal] = useState<GoalStatusPayload | null>(null);
  // 切换会话时在**本次 render 内**同步清空旧目标(React 官方"render 期重置 state"模式):
  // 否则 async getGoalStatus 返回前,GoalIndicator 会拿着**新** sessionId 渲染**旧**会话的目标,
  // pause/resume/clear/edit 会误发到错的会话(如从有目标的 A 切到 B 时点垃圾桶 → clearGoal(B);
  // reviewer #354)。比放进 effect 清空更早(effect 在 paint 后才跑),DOM 永不出现错配那一帧。
  const [trackedSessionId, setTrackedSessionId] = useState(sessionId);
  if (sessionId !== trackedSessionId) {
    setTrackedSessionId(sessionId);
    setGoal(null);
  }

  // origin 注入时重拉状态 + 重绑订阅;粘滞源保证重连清镜像窗口内 snapshot 不变,
  // effect 不重跑、不被换绑回本机(Codex review #548 两轮)。
  const originDeviceId = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => getStickySessionDeviceId(sessionId),
  );

  useEffect(() => {
    if (!sessionId) {
      setGoal(null);
      return;
    }
    let active = true;
    void goalApiFor(sessionId)
      .getGoalStatus(sessionId)
      .then((g) => {
        if (active) setGoal(g);
      })
      .catch(() => {
        if (active) setGoal(null);
      });
    const unsub = subscribeGoalStatusChanged(sessionId, (payload) => {
      setGoal(payload.goal);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [sessionId, originDeviceId]);

  return goal;
}
