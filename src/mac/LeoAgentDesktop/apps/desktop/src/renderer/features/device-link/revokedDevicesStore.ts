/**
 * revokedDevicesStore —— 控制端内存记:哪些被控端撤销了本机的访问权限(逐设备)。
 * ---------------------------------------------------------------------------
 * 控制端 = 纯镜像,不持久化:这份「已撤销」标记靠每次 subscribe 返回的 ACCESS_REVOKED
 * 重新推导(被控端的黑名单才是单一真相源)。两处消费:
 *  - useDeviceLinkRemoteProjects:收到 ACCESS_REVOKED / link-close('revoked') 时 markRevoked,
 *    重订阅成功(被控端恢复)时 clearRevoked;据此把该设备移出对话区。
 *  - 设置页「我的设备」(MyDevicesPanel)+ 侧边栏机器切换栏:useSyncExternalStore 读,显示
 *    「访问权限已被撤销,需对方在选项中恢复」/ 切换栏的「被拒」状态。
 *
 * getSnapshot 返回稳定引用(仅内容变化时换新),契合 useSyncExternalStore(无 tearing)。
 */

const revoked = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function recompute(): void {
  snapshot = new Set(revoked);
  for (const l of listeners) l();
}

export const revokedDevicesStore = {
  /** 标记某被控端已撤销本机访问权限(幂等)。 */
  markRevoked(deviceId: string): void {
    if (revoked.has(deviceId)) return;
    revoked.add(deviceId);
    recompute();
  },
  /** 清除某被控端的「已撤销」标记(被控端恢复 → 控制端重订阅成功时)。 */
  clearRevoked(deviceId: string): void {
    if (!revoked.delete(deviceId)) return;
    recompute();
  },
  /** 全清(登出 / WS 断开 / 卸载时;重连后由 reseed 重新推导)。 */
  clearAll(): void {
    if (revoked.size === 0) return;
    revoked.clear();
    recompute();
  },
  has(deviceId: string): boolean {
    return revoked.has(deviceId);
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): ReadonlySet<string> {
    return snapshot;
  },
};
