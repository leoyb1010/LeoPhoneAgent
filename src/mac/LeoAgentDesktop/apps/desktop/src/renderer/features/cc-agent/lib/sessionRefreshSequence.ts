/**
 * 全量 session GET 的 session-scoped latest-request-wins 序号器。
 *
 * sessions:patched 走字段 merge，不经过这里；只有会整行替换 serverSession 的 GET
 * 需要序号保护。scope 在 layout commit 阶段同步切换，旧会话闭包即使稍后才执行，
 * 也不能取消当前会话的请求或把旧整行响应写进新视图。
 */
export interface SessionRefreshSequence {
  setSession(sessionId: string | null): void;
  isCurrentSession(sessionId: string): boolean;
  begin(sessionId: string): number | null;
  isLatest(sessionId: string, sequence: number): boolean;
  invalidate(sessionId: string): void;
}

export function createSessionRefreshSequence(): SessionRefreshSequence {
  let currentSessionId: string | null = null;
  let current = 0;

  return {
    setSession(sessionId) {
      if (sessionId === currentSessionId) return;
      currentSessionId = sessionId;
      current += 1;
    },
    isCurrentSession(sessionId) {
      return sessionId === currentSessionId;
    },
    begin(sessionId) {
      if (sessionId !== currentSessionId) return null;
      current += 1;
      return current;
    },
    isLatest(sessionId, sequence) {
      return sessionId === currentSessionId && sequence === current;
    },
    invalidate(sessionId) {
      if (sessionId !== currentSessionId) return;
      current += 1;
    },
  };
}
