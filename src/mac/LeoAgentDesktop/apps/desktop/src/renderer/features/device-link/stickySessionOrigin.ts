/**
 * stickySessionOrigin —— 「最后已知会话归属」模块级缓存。
 *
 * remoteProjectsStore 的 sessionId→deviceId 注册表在 relay 瞬时重连时会被 clear()
 * (镜像随链路重建),而消费方(goal/learn 传输层、useGoalStatus/useLearnRun、
 * CCAgentSessionView 粘滞逻辑)需要在这个窗口内继续把远程会话当远程处理 ——
 * 把远程会话的操作降级回本机(如 learn:apply 落到控制端)比隧道失败严重得多。
 *
 * 语义:查询时先读 store 现值;有值则记入缓存并返回;无值时返回最后已知值。
 * 设备变化(dev→dev')由现值覆盖。缓存按 sessionId 累积、不主动清理 —— 单次
 * app 运行内会话数量有限,量级可忽略;会话真正的归属不会从远程变回本机
 * (本机会话永远不会进过这张表),故粘滞不会造成误判。
 *
 * 各传输层 / hooks 统一走这里,粘滞状态跨适配器重建、effect 重跑存活
 * (Codex review #548:per-resolver 粘滞在 effect 重建时会丢)。
 */

import { getSessionDeviceId } from './remoteProjectsStore';

const lastKnown = new Map<string, string>();

/** 解析会话归属设备:store 现值优先,清空窗口内回退最后已知值。 */
export function getStickySessionDeviceId(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  const fresh = getSessionDeviceId(sessionId);
  if (fresh !== undefined) {
    lastKnown.set(sessionId, fresh);
    return fresh;
  }
  return lastKnown.get(sessionId);
}

/** 测试专用:清空粘滞缓存。 */
export function __resetStickySessionOriginForTest(): void {
  lastKnown.clear();
}
