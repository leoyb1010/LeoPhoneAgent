/**
 * xdt-helper/end_team.ts —— 结束整个 workflow, 归档所有 worker 并关闭 Lead 协同模式。
 *
 * 与旧粗粒度入口不同: 本工具只负责 workflow 级别操作;
 * 单个 worker 归档走 archive_worker。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface EndTeamDeps {
  sessionId: string | undefined;
  vendorOptions: Record<string, unknown> | undefined;
  getSessionContext?: () => {
    sessionId?: string;
    vendorOptions?: Record<string, unknown>;
  };
  endTeam: (params: { leadSessionId: string }) => Promise<ControlResult>;
}

const DESCRIPTION =
  '结束当前 team, 归档所有 worker。Lead 自身保留可继续单 session 对话。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_CANNOT_DISABLE / NOT_ENABLED。';

export function registerEndTeamTool(
  registry: XdtHelperToolRegistry,
  deps: EndTeamDeps,
): void {
  registry.register({
    name: 'end_team',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {},
    handler: async () => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload(
          'LEAD_NOT_SUPPORTED',
          '当前 session 类型不支持作为 Lead, 没有可结束的 workflow。',
        );
      }
      const role = ctx.vendorOptions?.orcaRole;
      if (role === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_DISABLE',
          'Worker 不能结束自己所在的 workflow。',
        );
      }
      if (role !== 'lead') {
        return errorPayload(
          'NOT_ENABLED',
          '当前 session 未开启协同模式, 无需结束。',
        );
      }

      const result = await deps.endTeam({ leadSessionId: ctx.sessionId });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload('INTERNAL', result.message);
      }

      return okPayload({
        instruction: 'Workflow ended. All workers have been archived.',
      });
    },
  });
}
