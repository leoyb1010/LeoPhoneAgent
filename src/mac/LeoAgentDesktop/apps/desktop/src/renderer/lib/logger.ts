/**
 * Renderer-side logger — same shape as main/logger.ts.
 *
 * - All levels forward to main via `electronAPI.logToMain`; main applies the
 *   level filter and writes to `<userData>/logs/main.log` so a single file
 *   holds main + renderer output.
 * - Dev: also mirrors to DevTools console so live debugging keeps working.
 * - Prod: silent locally, only writes through main.
 *
 * Usage:
 *   import { createLogger } from '@/lib/logger';
 *   const log = createLogger('ChatStore');
 *   log.info('state changed', state);
 *   log.warn('token refresh failed', err);
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const isProd = import.meta.env.PROD;

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function stringify(args: unknown[]): string {
  return args.map(stringifyArg).join(' ');
}

function forward(level: LogLevel, scope: string, args: unknown[]): void {
  try {
    window.electronAPI?.logToMain?.(level, scope, stringify(args));
  } catch {
    /* preload not ready or IPC failed — silent */
  }
}

function devMirror(level: LogLevel, scope: string, args: unknown[]): void {
  if (isProd) return;
  const tag = `[${level}] [${scope}]`;
  if (level === 'error' || level === 'fatal') console.error(tag, ...args);
  else if (level === 'warn') console.warn(tag, ...args);
  // trace/debug → console.debug:DevTools 归入 Verbose,默认级别下不显示,
  // 需要时勾选 Verbose 查看(常驻基线类日志靠这层保持 console 安静)。
  else if (level === 'trace' || level === 'debug') console.debug(tag, ...args);
  else console.log(tag, ...args);
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  devMirror(level, scope, args);
  forward(level, scope, args);
}

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (...args) => emit('trace', scope, args),
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    fatal: (...args) => emit('fatal', scope, args),
  };
}

// ── PII helpers (mirror of main/logger.ts) ───────────────────────────────────

/** Last 2 path segments preceded by `.../` — strips the user's home prefix. */
export function maskPath(p: string | null | undefined): string {
  if (!p) return '<null>';
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter((s) => s.length > 0);
  if (parts.length <= 2) return p;
  return `...${sep}${parts.slice(-2).join(sep)}`;
}

/** `u***@<domain>` — preserves "same user" correlation without the identity. */
export function maskEmail(e: string | null | undefined): string {
  if (!e) return '<none>';
  const at = e.indexOf('@');
  if (at <= 0) return '***';
  const domain = e.slice(at);
  const local = e.slice(0, at);
  if (local.length < 2) return `***${domain}`;
  return `${local[0]}***${domain}`;
}
