/**
 * @cindy/im logger
 * ---------------------------------------------------------------------------
 * Tiny logger interface; mirrors @cindy/mcps's LiziMcpLogger pattern. Hosts can
 * provide their own implementation via `IMHost.createLogger`; otherwise we fall
 * back to a console logger that prefixes the scope.
 *
 * Six levels (trace/debug/info/warn/error/fatal) follow the same shape used in
 * apps/desktop/src/main/logger.ts so that host adapters can pass-through with
 * zero ceremony.
 */

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

export function defaultLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    trace: (...a) => console.debug(prefix, ...a),
    debug: (...a) => console.debug(prefix, ...a),
    info: (...a) => console.log(prefix, ...a),
    warn: (...a) => console.warn(prefix, ...a),
    error: (...a) => console.error(prefix, ...a),
    fatal: (...a) => console.error(prefix, ...a),
  };
}
