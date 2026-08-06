/**
 * ghostSessionActivityStore.ts — 意识后台活动(card-action 干活)的会话忙闲源。
 * ---------------------------------------------------------------------------
 * 主机在 card-action 派发时点亮、card-update state:'done' / TTL 超时熄灭,
 * 0↔1 转变经 'ghosts:session-activity' 推送到达。本 store 只存 busy 会话
 * id 集合,供侧栏 SessionStatusIcon 把"意识在干活"OR 进呼吸判断——
 * card-action 链路不经 LLM turn,makerChatStore 的 isRunning 天然不亮。
 *
 * 订阅纪律与 sessionAttentionStore 同款:组件按 sessionId 订阅 primitive
 * (boolean),逐行挂载不退回整表订阅(性能不变量)。
 */

import { useSyncExternalStore } from 'react';

const busySessions = new Set<string>();
const listeners = new Set<() => void>();
let subscribed = false;

/** 首次被消费时才挂推送订阅(模块导入零副作用;测试环境无 electronAPI 也安全)。 */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  const api = (window as unknown as {
    electronAPI?: {
      ghosts?: {
        onSessionActivity?: (cb: (p: { sessionId: string; busy: boolean }) => void) => () => void;
      };
    };
  }).electronAPI;
  api?.ghosts?.onSessionActivity?.((payload) => {
    if (!payload || typeof payload.sessionId !== 'string') return;
    const had = busySessions.has(payload.sessionId);
    if (payload.busy === had) return;
    if (payload.busy) busySessions.add(payload.sessionId);
    else busySessions.delete(payload.sessionId);
    for (const cb of [...listeners]) cb();
  });
}

function subscribe(cb: () => void): () => void {
  ensureSubscribed();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 某会话当前是否有意识后台活动(primitive 快照,per-row 精准订阅)。 */
export function useGhostSessionBusy(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => busySessions.has(sessionId),
    () => false,
  );
}

/** 测试专用:直灌一条忙闲变化(绕过 IPC)。 */
export function __ingestGhostSessionActivityForTest(sessionId: string, busy: boolean): void {
  if (busy) busySessions.add(sessionId);
  else busySessions.delete(sessionId);
  for (const cb of [...listeners]) cb();
}

/** 测试专用:清空全部状态。 */
export function __resetGhostSessionActivityForTest(): void {
  busySessions.clear();
  listeners.clear();
  subscribed = false;
}
