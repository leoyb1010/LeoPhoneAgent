/**
 * xdt-helper/idle_worker.ts —— 主动将 worker 设为 idle 状态。
 * Idle worker 不占用 SDK 进程内存, 可被后台 idle watcher 自动释放或手动唤醒。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface IdleWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  idleWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
  }) => Promise<ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND' | 'ALREADY_IDLE'>>;
}

const DESCRIPTION =
  '将 worker 设为 idle(释放进程, 后续 switch_focus 可唤醒)。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / ALREADY_IDLE。';

export function registerIdleWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: IdleWorkerDeps,
): void {
  registry.register({
    name: 'idle_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('要设为 idle 的 worker id'),
    },
    handler: async ({ worker_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.idleWorker({
        callerLeadSessionId: ctx.sessionId,
        workerId: worker_id,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        instruction: 'Worker is now idle. SDK 进程已关闭, 内存已释放。',
      });
    },
  });
}
