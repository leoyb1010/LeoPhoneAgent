/**
 * xdt-helper/archive_worker.ts —— 归档单个 worker (abort + close SDK + archive DB)。
 * 不影响同 workflow 其他 worker。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface ArchiveWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  archiveWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
  }) => Promise<ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND'>>;
}

const DESCRIPTION =
  '归档单个 worker(不影响同 team 其他 worker)。失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND。';

export function registerArchiveWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: ArchiveWorkerDeps,
): void {
  registry.register({
    name: 'archive_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('要归档的 worker id'),
    },
    handler: async ({ worker_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.archiveWorker({
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
        instruction: 'Worker archived.',
      });
    },
  });
}
