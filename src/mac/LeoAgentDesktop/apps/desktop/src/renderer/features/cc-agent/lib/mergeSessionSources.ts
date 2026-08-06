/**
 * mergeSessionSources —— 合并「本地 DB 会话」与「device-link 远程镜像会话」。
 *
 * 背景:本地会话来自 sessionsStore(useCCSessions),被控端的远程会话来自
 * remoteProjectsStore(useRemoteProjectSessions),两者是**两个独立来源**。需要按
 * sessionId 解析一个会话(尤其 orca lead / worker)时,必须同时覆盖两个来源——
 * 否则远程 orca 会话在只读本地的组件里 find 不到(真机实测:控制端打开受控端协同
 * 会话时 OrcaWorkflowRoute 因 leadSession=null 直接把人弹回 /cc-agent)。
 *
 * 语义:本地优先(同 id 时保留本地那条),远程仅补充本地没有的 id。引用稳定:
 * remote 为空时直接返回 local 原引用,避免无谓重渲染。CCAgentSessionView 早有同款
 * `local.find(...) ?? remote.find(...)` 内联 idiom,这里抽成纯函数供 orca 视图复用 + 单测。
 */

import type { Session } from '@/lib/ccAgent.types';

export function mergeSessionSources(
  local: readonly Session[],
  remote: readonly Session[],
): Session[] {
  if (remote.length === 0) return local as Session[];
  const localIds = new Set(local.map((s) => s.id));
  const merged: Session[] = [...local];
  for (const s of remote) {
    if (!localIds.has(s.id)) merged.push(s);
  }
  return merged;
}
