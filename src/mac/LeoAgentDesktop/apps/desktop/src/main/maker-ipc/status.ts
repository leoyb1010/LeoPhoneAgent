/**
 * apps/desktop/src/main/maker-ipc/status.ts
 *
 * maker:agent:status IPC 的 Electron adapter —— 取代老 codex:binary:status。
 *
 * handler body 在 statusHandlers.ts，便于不启动 Electron 直接测试。
 */

import type { Maker } from '@cindy/maker-core';
import { createLogger } from '../logger.js';

import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';
import { registerMakerStatusHandlers } from './statusHandlers.js';

const log = createLogger('maker-ipc:status');

export function registerMakerStatusIpc(maker: Maker): void {
  log.info('registering maker:agent:status IPC handler');

  registerMakerStatusHandlers(createElectronIpcHandlerRegistry(), maker);

  log.info('maker:agent:status registered');
}
