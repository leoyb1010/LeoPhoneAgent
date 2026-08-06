/**
 * logging — host-injected logger indirection.
 *
 * 这个包同时跑在两种宿主里:desktop main(日志走统一 logger 模块,规则 12)
 * 和远端 file-service daemon(日志走 stderr,stdout 被 NDJSON RPC 独占)。
 * 两边的日志设施完全不同,所以包内不落任何具体实现——宿主启动时通过
 * `setFileBrowserCoreLoggerFactory` 注入自己的 factory,注入前所有日志静默丢弃
 * (noop),不缓存不排队:这个包里没有"错过就无法诊断"级别的日志。
 *
 * `scopedLogger` 返回的代理对象在每次调用时才解析当前 factory,因此模块顶层
 * `const log = scopedLogger('...')` 的声明顺序与注入时机无关。
 */

/** 与 desktop main logger 的宽松签名保持一致((...args: unknown[]))。 */
export interface CoreLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type CoreLoggerFactory = (scope: string) => CoreLogger;

const noopLogger: CoreLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let currentFactory: CoreLoggerFactory = () => noopLogger;

/** 宿主注入自己的 logger factory(desktop: createLogger;daemon: stderr logger)。 */
export function setFileBrowserCoreLoggerFactory(factory: CoreLoggerFactory): void {
  currentFactory = factory;
}

/**
 * 包内模块用这个拿 scope logger。惰性解析:每次真正打日志时才向当前 factory
 * 要实例(factory 变更后自动切换),factory 未变时复用缓存实例避免每条日志重建。
 */
export function scopedLogger(scope: string): CoreLogger {
  let cached: CoreLogger | null = null;
  let cachedFrom: CoreLoggerFactory | null = null;
  const resolve = (): CoreLogger => {
    if (!cached || cachedFrom !== currentFactory) {
      cached = currentFactory(scope);
      cachedFrom = currentFactory;
    }
    return cached;
  };
  return {
    debug: (...args) => resolve().debug(...args),
    info: (...args) => resolve().info(...args),
    warn: (...args) => resolve().warn(...args),
    error: (...args) => resolve().error(...args),
  };
}
