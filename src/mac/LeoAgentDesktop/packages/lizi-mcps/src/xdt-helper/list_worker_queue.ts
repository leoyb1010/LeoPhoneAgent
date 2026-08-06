/**
 * xdt-helper/list_worker_queue.ts —— 列出指定 worker 输入队列中排队的消息。
 *
 * Lead 派发的消息在 worker 忙时会排队(send_to_worker 的 wake_kind=queued);
 * 本工具让 lead 在消息被消费前看到队列全貌。口径「看得全、只能动自己的」:
 * 三种来源(lead / 用户手打 / scheduler)的条目都回传正文,供 lead 基于完整
 * 队列内容做编排;但修改 / 撤回只对 lead 自己的条目开放。
 */

import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/** 单条排队消息的 lead 可见投影(与 host WorkerQueuedMessageSnapshot 同构)。 */
export interface WorkerQueuedMessageEntry {
  queuedMessageId: string;
  position: number;
  source: 'lead' | 'user' | 'scheduler';
  content: string;
  consuming: boolean;
}

export interface ListWorkerQueueDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  listWorkerQueuedMessages: (params: {
    callerLeadSessionId: string;
    workerRef: string;
  }) => Promise<
    ControlResult<
      {
        workerId: string;
        workerSessionId: string;
        messages: WorkerQueuedMessageEntry[];
      },
      'WORKER_NOT_FOUND'
    >
  >;
}

const DESCRIPTION =
  '列出指定 worker 输入队列中正在排队(尚未被消费)的消息,每条含来源、位置与正文。' +
  'source=lead 的条目是你自己发的(send_to_worker / initial_task 排队产生),' +
  '可用 update_queued_message / cancel_queued_message 修改或撤回;' +
  'source=user / scheduler 的条目正文可见(供理解排队顺序与内容),但不可修改/撤回。' +
  'consuming=true 表示该条正在投递中,已不可修改/撤回。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND。';

export function registerListWorkerQueueTool(
  registry: XdtHelperToolRegistry,
  deps: ListWorkerQueueDeps,
): void {
  registry.register({
    name: 'list_worker_queue',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('目标 worker 的 worker_id 或 session_id 任一'),
    },
    handler: async ({ worker_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 队列操作。');
      }
      const result = await deps.listWorkerQueuedMessages({
        callerLeadSessionId: ctx.sessionId,
        workerRef: worker_id,
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        worker_session_id: result.workerSessionId,
        queue: result.messages.map((entry) => ({
          queued_message_id: entry.queuedMessageId,
          position: entry.position,
          source: entry.source,
          content: entry.content,
          consuming: entry.consuming,
        })),
      });
    },
  });
}
