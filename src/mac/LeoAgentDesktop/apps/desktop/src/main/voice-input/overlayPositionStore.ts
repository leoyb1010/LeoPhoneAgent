import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import {
  normalizeSavedOverlayPosition,
  type SavedOverlayPosition,
} from './overlayPlacement.js';

const log = createLogger('voice-input:overlay-position');
const POSITION_FILE_NAME = 'voice-input-overlay-position.v1.json';

/**
 * 语音输入全局浮窗「记住位置」的持久化 store。
 *
 * 位置记忆放 main 侧（而非 renderer localStorage）：窗口真实 bounds 只有
 * main 知道，且 Windows 上浮窗每次关闭后销毁重建，renderer 状态活不过
 * 一次会话。写盘只发生在拖动结束 / 双击复位时（低频），读走内存缓存。
 */
class VoiceInputOverlayPositionStore {
  /** undefined = 尚未从磁盘加载；null = 无保存位置。 */
  private cached: SavedOverlayPosition | null | undefined;

  read(): SavedOverlayPosition | null {
    if (this.cached !== undefined) return this.cached;
    try {
      const raw = fs.readFileSync(getPositionFilePath(), 'utf-8');
      this.cached = normalizeSavedOverlayPosition(JSON.parse(raw));
    } catch (error) {
      this.cached = null;
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        log.warn('read overlay position failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.cached;
  }

  save(position: SavedOverlayPosition): void {
    this.cached = position;
    const filePath = getPositionFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(position, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      log.warn('save overlay position failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clear(): void {
    this.cached = null;
    try {
      fs.rmSync(getPositionFilePath(), { force: true });
    } catch (error) {
      log.warn('clear overlay position failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function getPositionFilePath(): string {
  return path.join(app.getPath('userData'), POSITION_FILE_NAME);
}

export const voiceInputOverlayPositionStore = new VoiceInputOverlayPositionStore();
