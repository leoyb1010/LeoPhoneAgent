/**
 * Logger — 日志输出抽象（host 注入）。
 *
 * 故意不依赖 electron-log / winston / pino，使用最简单的 6 级接口。
 * desktop host: 包装现有 createLogger() 实现。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  fatal(msg: string, ctx?: Record<string, unknown>): void;
  /** 创建带 scope 前缀的子 logger */
  child(scope: string): Logger;
}

/** 默认 console 实现，便于测试 */
export function createConsoleLogger(scope = 'maker'): Logger {
  const make = (level: LogLevel) => (msg: string, ctx?: Record<string, unknown>): void => {
    const line = ctx ? `[${scope}] ${msg} ${JSON.stringify(ctx)}` : `[${scope}] ${msg}`;
    if (level === 'error' || level === 'fatal') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };
  return {
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    child(sub) {
      return createConsoleLogger(`${scope}/${sub}`);
    },
  };
}
