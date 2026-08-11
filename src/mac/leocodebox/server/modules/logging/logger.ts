/**
 * Small structured logger used by the local server.
 *
 * Set LOG_LEVEL=debug|info|warn|error to control verbosity. The default is
 * `info` in development and `warn` in production so normal request paths do
 * not flood stdout. Every log call keeps the original metadata object intact
 * for readable local diagnostics and future structured transports.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error'
    ? normalized
    : process.env.NODE_ENV === 'production' ? 'warn' : 'info';
}

function normalizeArgs(args: unknown[]): unknown[] {
  return args.map((value) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    return value;
  });
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[resolveLevel(process.env.LOG_LEVEL)]) return;
  const prefix = `[${level.toUpperCase()}]`;
  const output = normalizeArgs(args);
  if (level === 'error') console.error(prefix, ...output);
  else if (level === 'warn') console.warn(prefix, ...output);
  else console.log(prefix, ...output);
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
