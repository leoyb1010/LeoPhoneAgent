/**
 * pendingProjectFocus —— "请求聚焦某个 project" 的一次性信号
 *
 * 场景：cindy://project/<workingDir>(历史 xdt-maker:// 同)深度链接到达时，MainLayout 调
 * `requestProjectFocus(workingDir)`；CCAgentSidebarUpper 通过
 * useSyncExternalStore 订阅到信号后展开该 project + 滚到 viewport，处理完
 * 调 `consumePendingProjectFocus()` 把 flag 清零。
 *
 * 设计成一次性 token 是因为：
 *   - 同一个 workingDir 可能被多次点（用户连点链接）—— 每次都要触发一次效果，
 *     不能简单存 string 然后比 prev/next 是否变了
 *   - sidebar 可能还没 mount（用户点链接时正在 /settings）—— 把信号留着，
 *     等 sidebar mount 起来再消费
 */

import { useSyncExternalStore } from 'react';

interface PendingFocus {
  workingDir: string;
  /** 单调递增 nonce —— 同一 workingDir 连续两次请求需要触发两次 effect */
  nonce: number;
}

let pending: PendingFocus | null = null;
let nextNonce = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function requestProjectFocus(workingDir: string): void {
  if (!workingDir) return;
  pending = { workingDir, nonce: nextNonce++ };
  emit();
}

export function consumePendingProjectFocus(): void {
  if (!pending) return;
  pending = null;
  emit();
}

export function getPendingProjectFocus(): PendingFocus | null {
  return pending;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Hook —— sidebar 用它订阅。返回 null 表示当前无待处理 focus 请求。 */
export function usePendingProjectFocus(): PendingFocus | null {
  return useSyncExternalStore(subscribe, getPendingProjectFocus, getPendingProjectFocus);
}
