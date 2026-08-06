/**
 * useLearnRun / useLearnRuns —— learn run 状态订阅 hook。
 *
 * 数据源:learn:list-runs 拉初始快照 + learn:event push 增量更新。
 * run 状态的事实源在「会话归属设备」的 learn-host(runs.json),renderer 不缓存
 * 跨组件状态,每个订阅者独立 listRuns + 事件订阅(量极小,无性能问题)。
 * device-link 远程会话经 learnTransport 自动路由到被控端,本机行为不变。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';

import { extractIpcError } from '@/utils/ipcError';

import type { LearnRunPublic } from '../../../shared/learnTypes';
import { learnApiFor, subscribeLearnEvents } from './learnTransport';

/** 订阅单个 run 的最新状态(状态卡用)。runId 为空返回 null。
 *  contextSessionId = 组件所在会话视图的 sessionId,决定路由到哪台设备的 learn-host。 */
export function useLearnRun(
  runId: string | undefined,
  contextSessionId?: string | null,
): LearnRunPublic | null {
  const [run, setRun] = useState<LearnRunPublic | null>(null);
  // origin 注入(刚建的远程蒸馏会话异步注册 sessionId→deviceId)时重跑快照拉取 +
  // 事件重绑 —— 否则首帧解析成本机后永远拿不到被控端的 run(Codex review #548)。
  // 粘滞源:重连清镜像窗口内 snapshot 保持最后已知值 → effect 不因清空重跑,
  // 订阅不被换绑回本机(Codex review #548 第二轮)。
  const originDeviceId = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => getStickySessionDeviceId(contextSessionId),
  );

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    // 单调更新:快照/事件都只许"新盖旧"(按 updatedAt)。listRuns 的 IPC 往返
    // 期间 push 事件可能先到,旧快照后到不许回写覆盖(Greptile review:典型是
    // distilling→awaiting-review 事件先到,快照把状态倒回去且再无事件纠正)。
    const mergeRun = (incoming: LearnRunPublic | null): void => {
      setRun((prev) => {
        if (!incoming) return prev;
        if (prev && prev.runId === incoming.runId && incoming.updatedAt < prev.updatedAt) return prev;
        return incoming;
      });
    };
    void learnApiFor(contextSessionId)
      .listRuns()
      .then(({ runs }) => {
        if (cancelled) return;
        mergeRun(runs.find((r) => r.runId === runId) ?? null);
      })
      .catch(() => {
        // list-runs 是 fallback-data 型查询,异常按"暂无数据"处理
      });
    const off = subscribeLearnEvents(contextSessionId, (payload) => {
      if (payload.type === 'state-changed' && payload.run.runId === runId) {
        mergeRun(payload.run);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [runId, contextSessionId, originDeviceId]);

  return run;
}

/** 拉取与某会话关联、仍需要展示状态卡的 run(会话挂载时恢复 ephemeral 卡用)。
 *  ready=false 表示 learn-host 尚未就绪(启动期)—— 调用方应重试而非视为"无 run"。 */
export async function listActiveRunsForSession(
  sessionId: string,
): Promise<{ ready: boolean; runs: LearnRunPublic[] }> {
  try {
    const { runs, ready } = await learnApiFor(sessionId).listRuns();
    return {
      ready,
      runs: runs.filter(
        (r) =>
          // 触发会话与蒸馏会话都恢复状态卡:前者是回程链接,后者是提案闸门入口
          (r.originSessionId === sessionId || r.sessionId === sessionId) &&
          (r.status === 'collecting' || r.status === 'distilling' || r.status === 'awaiting-review'),
      ),
    };
  } catch (err) {
    // 终态错误不重试(对齐 refreshRemoteSessions 的永久/瞬态分类):老被控端白名单没有
    // learn 通道(CHANNEL_NOT_ALLOWED)重试也不会变,按"无 run 可恢复"收场,避免调用方
    // 的有界重试对着它空转刷错误日志;其余失败仍按"learn-host 未就绪"返回让调用方重试。
    if (extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
      return { ready: true, runs: [] };
    }
    return { ready: false, runs: [] };
  }
}
