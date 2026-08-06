import type { RsbWindowCommandRouteResult } from '../../../../shared/rightSidebarWindow';

export const TERMINAL_ROUTE_MAX_ATTEMPTS = 8;
export const TERMINAL_ROUTE_RETRY_DELAY_MS = 100;

export type OpenTerminalShortcutResult = 'handled' | 'cancelled' | 'exhausted';

interface OpenTerminalShortcutOptions {
  signal: AbortSignal;
  isCurrentSession: () => boolean;
  routeCommand: () => Promise<RsbWindowCommandRouteResult>;
  openAttachedTerminal: () => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 终端快捷键专属的有限重试。main 的 stale-context 表示命令没有落到任一 host，
 * 因而可以安全重试；其它结果均表示 ownership 已确定，必须立即停止以免重复开 tab。
 */
export async function openTerminalFromShortcut(
  opts: OpenTerminalShortcutOptions,
): Promise<OpenTerminalShortcutResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? TERMINAL_ROUTE_MAX_ATTEMPTS);
  const retryDelayMs = opts.retryDelayMs ?? TERMINAL_ROUTE_RETRY_DELAY_MS;
  const wait = opts.waitForRetry ?? waitForRetry;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (opts.signal.aborted || !opts.isCurrentSession()) return 'cancelled';
    const routeResult = await opts.routeCommand();
    if (opts.signal.aborted || !opts.isCurrentSession()) return 'cancelled';

    if (routeResult === 'attached') {
      await opts.openAttachedTerminal();
      return 'handled';
    }
    if (routeResult === 'routed' || routeResult === 'queued') return 'handled';
    if (attempt === maxAttempts - 1) return 'exhausted';
    if (!(await wait(retryDelayMs, opts.signal))) return 'cancelled';
  }

  return 'exhausted';
}
