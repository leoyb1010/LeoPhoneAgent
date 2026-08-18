import { useEffect, useMemo, useReducer } from 'react';

import type { ServerEvent } from '../contexts/WebSocketContext';

/** sessionId → 该会话当前挂起的 requestId 集合。 */
export type ApprovalMap = ReadonlyMap<string, ReadonlySet<string>>;

export type ApprovalAction =
  /** 服务端发来一条新的工具授权请求。 */
  | { type: 'request'; sessionId: string; requestId: string }
  /** 该请求被取消/超时,或用户已经答复。 */
  | { type: 'resolve'; sessionId: string | null; requestIds: string[] }
  /** chat_subscribed 的 ack 带着这个会话的权威挂起列表,整份覆盖。 */
  | { type: 'sync'; sessionId: string; requestIds: string[] }
  /** 一次 run 结束(complete)或会话被删除:该会话不可能再有挂起项。 */
  | { type: 'clear'; sessionId: string };

function withSession(
  state: ApprovalMap,
  sessionId: string,
  requestIds: ReadonlySet<string>,
): ApprovalMap {
  const next = new Map(state);
  if (requestIds.size === 0) next.delete(sessionId);
  else next.set(sessionId, requestIds);
  return next;
}

/**
 * 待审批状态的归约器 —— 纯函数,方便直接对着事件序列断言。
 *
 * 只认四种事实:来了(request)、没了(resolve)、服务端对表(sync)、
 * run 结束(clear)。任何"这个会话刚才有动静"都**不算**待审批。
 */
export function approvalsReducer(state: ApprovalMap, action: ApprovalAction): ApprovalMap {
  switch (action.type) {
    case 'request': {
      const current = state.get(action.sessionId);
      if (current?.has(action.requestId)) return state;
      const next = new Set(current ?? []);
      next.add(action.requestId);
      return withSession(state, action.sessionId, next);
    }
    case 'resolve': {
      if (action.requestIds.length === 0) return state;
      // permission_cancelled 不一定带 sessionId(旧 runtime 会漏),
      // 这时按 requestId 全表扫一遍 —— requestId 本身是全局唯一的。
      const targets = action.sessionId ? [action.sessionId] : [...state.keys()];
      let result = state;
      for (const sessionId of targets) {
        const current = result.get(sessionId);
        if (!current) continue;
        const next = new Set(current);
        let changed = false;
        for (const requestId of action.requestIds) {
          if (next.delete(requestId)) changed = true;
        }
        if (changed) result = withSession(result, sessionId, next);
      }
      return result;
    }
    case 'sync': {
      const current = state.get(action.sessionId);
      const same = current
        ? current.size === action.requestIds.length
          && action.requestIds.every((requestId) => current.has(requestId))
        : action.requestIds.length === 0;
      if (same) return state;
      return withSession(state, action.sessionId, new Set(action.requestIds));
    }
    case 'clear': {
      if (!state.has(action.sessionId)) return state;
      return withSession(state, action.sessionId, new Set());
    }
    default:
      return state;
  }
}

const EMPTY: ApprovalMap = new Map();

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** 把一条 websocket 帧翻译成 0 或 1 个 action;不相关的帧返回 null。 */
export function approvalActionFromEvent(event: ServerEvent): ApprovalAction | null {
  const sessionId = readString(event.sessionId);

  switch (String(event.kind)) {
    case 'permission_request': {
      const requestId = readString(event.requestId);
      if (!sessionId || !requestId) return null;
      return { type: 'request', sessionId, requestId };
    }
    case 'permission_cancelled': {
      const requestId = readString(event.requestId);
      if (!requestId) return null;
      return { type: 'resolve', sessionId, requestIds: [requestId] };
    }
    case 'chat_subscribed': {
      if (!sessionId) return null;
      const pending = Array.isArray(event.pendingPermissions) ? event.pendingPermissions : [];
      const requestIds = pending
        .map((entry) => readString((entry as { requestId?: unknown } | null)?.requestId))
        .filter((requestId): requestId is string => Boolean(requestId));
      return { type: 'sync', sessionId, requestIds };
    }
    case 'complete': {
      if (!sessionId) return null;
      return { type: 'clear', sessionId };
    }
    default:
      return null;
  }
}

/** 用户在会话里点了允许/拒绝之后,由 composer 派发这个事件。 */
export const APPROVAL_RESOLVED_EVENT = 'leocodebox:permission-resolved';

export type ApprovalResolvedDetail = { sessionId?: string | null; requestIds: string[] };

type Args = {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

/**
 * 会话级"待审批"的唯一状态源。
 *
 * 之前会话列表的橙色"待审批"标签复用的是 attentionSessionIds —— 那个集合的语义
 * 是"这个非当前会话刚有过任何动静"(assistant 输出、tool_use…都算),跟审批毫无
 * 关系,于是出现"挂着待审批、点进去什么都没有"。这里只跟踪真的 permission_request,
 * 并在取消/答复/run 结束时清掉。
 *
 * 注意:用户答复走的是 `chat.permission-response`,服务端不会回广播,所以 composer
 * 在发出答复时同步派发 APPROVAL_RESOLVED_EVENT 来销号。
 */
export function useSessionApprovals({ subscribe }: Args) {
  const [approvals, dispatch] = useReducer(approvalsReducer, EMPTY);

  useEffect(() => subscribe((event) => {
    const action = approvalActionFromEvent(event);
    if (action) dispatch(action);
  }), [subscribe]);

  useEffect(() => {
    const onResolved = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalResolvedDetail>).detail;
      const requestIds = Array.isArray(detail?.requestIds) ? detail.requestIds.filter(Boolean) : [];
      if (requestIds.length === 0) return;
      dispatch({ type: 'resolve', sessionId: detail?.sessionId ?? null, requestIds });
    };
    window.addEventListener(APPROVAL_RESOLVED_EVENT, onResolved);
    return () => window.removeEventListener(APPROVAL_RESOLVED_EVENT, onResolved);
  }, []);

  const approvalSessionIds = useMemo(
    () => new Set([...approvals.keys()]),
    [approvals],
  );

  return { approvals, approvalSessionIds };
}
