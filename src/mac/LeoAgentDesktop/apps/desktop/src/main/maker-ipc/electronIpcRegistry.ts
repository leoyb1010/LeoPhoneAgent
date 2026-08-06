/**
 * Electron ipcMain.handle 到纯 IPC registry 的适配层。
 *
 * 业务 handler 不直接依赖 Electron，测试可以用内存 registry 直接 invoke。
 */

import { ipcMain } from 'electron';

import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export function createElectronIpcHandlerRegistry(): IpcHandlerRegistry {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
    },
  };
}
