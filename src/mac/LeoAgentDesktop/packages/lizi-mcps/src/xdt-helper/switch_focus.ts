/**
 * xdt-helper/switch_focus.ts —— 切换当前 workflow 的 focused worker。
 * 同 workflow 内同时只能 1 个 focused worker, 切换后 UI 会完全替换 pane body。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface SwitchFocusDeps {
  sessionId: string | undefined;
  getSessionContext?: () => {
    sessionId?: string;
  };
  switchFocus: (params: {
    leadSessionId: string;
    workerIdOrLabel: string;
  }) => Promise<
    ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND'>
  >;
}

const DESCRIPTION =
  '切换 focused worker(UI 展示切到目标 worker)。idle worker 会自动唤醒。' +
  '定位键接受 worker_id / session_id / label 任一(worker_id、session_id 优先精确匹配, label 兜底)。' +
  '失败码: WORKER_NOT_FOUND。';

export function registerSwitchFocusTool(
  registry: XdtHelperToolRegistry,
  deps: SwitchFocusDeps,
): void {
  registry.register({
    name: 'switch_focus',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id_or_label: z
        .string()
        .min(1)
        .describe('目标 worker 的 worker_id / session_id / label 任一, 用于定位'),
    },
    handler: async ({ worker_id_or_label }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      const result = await deps.switchFocus({
        leadSessionId: ctx.sessionId,
        workerIdOrLabel: worker_id_or_label,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        instruction: 'Focused worker switched. The worker pane body now shows this worker session.',
      });
    },
  });
}
