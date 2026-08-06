/**
 * watcher-host 单例接线 — 真实 Electron 环境下的 WatcherHostClient。
 *
 * fork 细节:
 *   - 产物路径:与 main bundle 同目录的 watcherHostProcess.js(forge VitePlugin
 *     独立 entry,dev / packaged 布局一致,参考 db-worker 的解析方式)
 *   - @parcel/watcher 模块路径由 main 预解析后经 env 传入,避免子进程在
 *     packaged(asar.unpacked)布局下猜错解析根
 *   - app before-quit 时 dispose(kill 子进程、抑制退出期的误重启)
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { app, utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { WatcherHostClient } from './WatcherHostClient.js';
import { WATCHER_HOST_ENV_PARCEL_MODULE } from './protocol.js';

export type {
  WatcherHostSubscription,
  WatcherHostEventsHandler,
  WatcherHostErrorHandler,
} from './WatcherHostClient.js';
export type { WatchedFsEvent } from './protocol.js';

const log = createLogger('watcher-host');

const _require = createRequire(__filename);

function resolveParcelModulePath(): string | undefined {
  try {
    return _require.resolve('@parcel/watcher');
  } catch (err) {
    log.warn('resolve @parcel/watcher from main failed, host will bare-require', err);
    return undefined;
  }
}

function forkWatcherHost(): ReturnType<typeof utilityProcess.fork> {
  const entry = path.join(__dirname, 'watcherHostProcess.js');
  const parcelModulePath = resolveParcelModulePath();
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'xdt-watcher-host',
    env: {
      ...process.env,
      ...(parcelModulePath ? { [WATCHER_HOST_ENV_PARCEL_MODULE]: parcelModulePath } : {}),
    },
  });
  log.info(`watcher host forked: ${entry}`);
  return child;
}

/** main 进程全局唯一的 watcher host client。 */
export const watcherHostClient = new WatcherHostClient({
  fork: forkWatcherHost,
  log,
});

app.once('before-quit', () => {
  watcherHostClient.dispose();
});
