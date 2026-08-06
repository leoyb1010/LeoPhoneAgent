/**
 * registerMakerPlanWriteIpc — maker:write-plan-file
 *
 * 把 ExitPlanMode 卡片里编辑的 plan 落盘。Stage 2 C1: 从 bootstrap-electron
 * 'cc-agent:plan-file-write' 搬过来, 改名 maker:* 前缀; 路径校验逻辑完全等价。
 *
 * 安全约束 (与老 handler 一致):
 *   - planFilePath 必须是绝对路径
 *   - normalize 后不允许 .. 段 (路径穿越)
 *   - 仅允许 .md 扩展名 (ExitPlanMode 永远是 Markdown)
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { createLogger } from '../logger.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/plan-write');

export function registerMakerPlanWriteIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.WRITE_PLAN_FILE,
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { requestId: string; planFilePath: string; content: string },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const { planFilePath, content } = params;

        if (typeof planFilePath !== 'string' || !planFilePath) {
          return { success: false, error: 'Missing planFilePath' };
        }
        if (typeof content !== 'string') {
          return { success: false, error: 'Invalid content' };
        }
        if (!path.isAbsolute(planFilePath)) {
          return { success: false, error: 'planFilePath must be absolute' };
        }
        const normalized = path.normalize(planFilePath);
        if (normalized.split(path.sep).includes('..')) {
          return { success: false, error: 'Path traversal not allowed' };
        }
        if (!normalized.toLowerCase().endsWith('.md')) {
          return { success: false, error: 'Only .md files are writable here' };
        }

        await fs.promises.writeFile(normalized, content, 'utf-8');
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('write-plan-file failed', { error: message });
        return { success: false, error: message };
      }
    },
  );
}
