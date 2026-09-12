import { useCallback, useEffect, useState } from 'react';

import type { ChatQueueItem } from '../../../../shared/chat-session-protocol';
import type { ServerEvent } from '../../../contexts/WebSocketContext';

type Args = {
  sessionId: string | null;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  sendMessage: (message: unknown) => void;
  isConnected: boolean;
};

const EMPTY_QUEUE: ChatQueueItem[] = [];
function readQueue(items: unknown): ChatQueueItem[] | null {
  if (!Array.isArray(items)) return null;
  return items.filter((value): value is ChatQueueItem => Boolean(value && typeof value === 'object'
    && typeof value.id === 'string' && typeof value.sessionId === 'string' && typeof value.content === 'string'
    && ['queued', 'needs_confirmation'].includes(value.state)));
}

/** Queue state comes from server snapshots; reconnecting never authorizes resume. */
export function useChatQueue({ sessionId, subscribe, sendMessage, isConnected }: Args) {
  const [queues, setQueues] = useState<Record<string, ChatQueueItem[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingActionIds, setPendingActionIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => subscribe((event) => {
    const sid = typeof event.sessionId === 'string' ? event.sessionId : null;
    if (!sid) return;
    const items = readQueue(event.queueItems);
    if (items) {
      setQueues((previous) => ({ ...previous, [sid]: items.filter((item) => item.sessionId === sid) }));
      setPendingActionIds(new Set());
      if (event.kind === 'chat_subscribed') setErrors((previous) => ({ ...previous, [sid]: '' }));
    }
    if (event.kind === 'chat_queue_action_ack') {
      setPendingActionIds((previous) => new Set([...previous].filter((id) => id !== event.queueItemId)));
      if (['cancelled', 'resumed'].includes(String(event.status))) setErrors((previous) => ({ ...previous, [sid]: '' }));
      else {
        setErrors((previous) => ({ ...previous, [sid]: event.status === 'already_started'
          ? '这项任务已开始；取消排队不会停止正在运行的任务。' : '队列状态已变化，请按最新列表操作。' }));
      }
    }
    if (event.kind === 'protocol_error' && event.scope === 'queue') {
      setErrors((previous) => ({ ...previous, [sid]: event.code === 'QUEUE_FULL'
        ? '队列已满，请取消一项或等待任务完成后重试。' : String(event.error || '任务未被加入队列。') }));
    }
    if (typeof event.persistenceWarning === 'string') {
      setErrors((previous) => ({ ...previous, [sid]: event.persistenceWarning as string }));
    }
  }), [subscribe]);

  useEffect(() => {
    if (!isConnected) setPendingActionIds(new Set());
  }, [isConnected]);

  const actOnQueue = useCallback((action: 'cancel' | 'resume', itemId: string) => {
    if (!sessionId) return;
    if (!isConnected) {
      setErrors((previous) => ({ ...previous, [sessionId]: '连接已断开，尚未发送队列操作。恢复连接后请重试。' }));
      return;
    }
    setErrors((previous) => ({ ...previous, [sessionId]: '' }));
    setPendingActionIds((previous) => new Set([...previous, itemId]));
    sendMessage({ type: `chat.queue.${action}`, sessionId, queueItemId: itemId });
  }, [isConnected, sendMessage, sessionId]);

  return {
    queueItems: sessionId ? queues[sessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
    queueError: sessionId ? errors[sessionId] ?? '' : '',
    pendingActionIds,
    cancelQueueItem: useCallback((itemId: string) => actOnQueue('cancel', itemId), [actOnQueue]),
    resumeQueueItem: useCallback((itemId: string) => actOnQueue('resume', itemId), [actOnQueue]),
  };
}
