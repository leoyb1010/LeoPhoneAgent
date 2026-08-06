/**
 * 初始完整 session snapshot 尚未到达时，暂存已确认落库的字段 patch。
 *
 * buffer 只属于当前 session；切换 scope 会丢弃旧会话 patch。完整 GET 到达后把暂存字段
 * 覆盖到 snapshot 上，既保留完整 row，也保证较新的 patch 不被旧 GET 反向覆盖。
 */
export interface SessionSnapshotPatchBuffer<T extends object> {
  setSession(sessionId: string | null): void;
  stage(sessionId: string, patch: Partial<T>): void;
  merge(sessionId: string, snapshot: T): T;
  acknowledgeCommitted(sessionId: string, snapshot: T): void;
}

export function createSessionSnapshotPatchBuffer<
  T extends object,
>(): SessionSnapshotPatchBuffer<T> {
  let currentSessionId: string | null = null;
  let pendingPatch: Partial<T> | null = null;
  let revision = 0;
  const mergedRevisions = new WeakMap<T, number>();

  return {
    setSession(sessionId) {
      if (sessionId === currentSessionId) return;
      currentSessionId = sessionId;
      pendingPatch = null;
      revision += 1;
    },
    stage(sessionId, patch) {
      if (sessionId !== currentSessionId) return;
      pendingPatch = { ...(pendingPatch ?? {}), ...patch };
      revision += 1;
    },
    merge(sessionId, snapshot) {
      if (sessionId !== currentSessionId || !pendingPatch) return snapshot;
      const merged = { ...snapshot, ...pendingPatch };
      mergedRevisions.set(merged, revision);
      return merged;
    },
    acknowledgeCommitted(sessionId, snapshot) {
      if (sessionId !== currentSessionId || !pendingPatch) return;
      // 只确认真正进入 React committed state 的精确 revision。中断 render 不会调用这里；
      // 若确认前又到达新 patch，旧 snapshot 也不能把更新后的 buffer 清空。
      if (mergedRevisions.get(snapshot) === revision) pendingPatch = null;
    },
  };
}
