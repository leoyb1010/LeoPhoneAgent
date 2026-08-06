/**
 * feishu/moduleScope.ts
 * ---------------------------------------------------------------------------
 * Module-level singleton holding the IMHost adapter and a logger. The FeishuIM
 * constructor calls `setHost(host, log)` once; all internal helpers grab
 * dependencies via `getHost()` / `getLog()` so we don't thread `host` through
 * every function signature.
 *
 * Throws if accessed before initialisation — caller bug.
 */

import type { IMHost } from '../types.js';
import { defaultLogger, type Logger } from '../logger.js';

let _host: IMHost | null = null;
let _log: Logger = defaultLogger('im:feishu');

export function setHost(host: IMHost, log: Logger): void {
  _host = host;
  _log = log;
}

export function getHost(): IMHost {
  if (!_host) {
    throw new Error('FeishuIM not initialized — call createFeishuIM(host) first');
  }
  return _host;
}

export function getLog(): Logger {
  return _log;
}

export function makeScopedLogger(scope: string): Logger {
  const host = _host;
  return host?.createLogger?.(`im:feishu:${scope}`) ?? defaultLogger(`im:feishu:${scope}`);
}
