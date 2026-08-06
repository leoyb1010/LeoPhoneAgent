import { createLogger } from '@/lib/logger';

const log = createLogger('foreground-recovery');
const PERFORMANCE_ENTRY_CLEANUP_THRESHOLD = 1_000;
const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 5_000;
const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_KEY = '__xdtPerformanceTimelineCleanupIntervalId';
const FOREGROUND_RECOVERY_DISPOSER_KEY = '__xdtForegroundRecoveryDiagnosticsDisposer';

export interface PerformanceLike {
  now: () => number;
  getEntriesByType: (type: string) => readonly unknown[];
  clearMeasures: () => void;
  clearMarks: () => void;
}

export interface ForegroundRecoverySnapshot {
  nowMs: number;
  measureCount: number;
  markCount: number;
}

type PerformanceTimelineCleanupTarget = {
  setInterval: (handler: () => void, timeout: number) => number;
  clearInterval: (id: number) => void;
  __xdtPerformanceTimelineCleanupIntervalId?: number;
};

type ForegroundRecoveryInstallTarget = {
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    __xdtForegroundRecoveryDiagnosticsDisposer?: () => void;
  };
  performance: PerformanceLike;
};

export function captureForegroundRecoverySnapshot(
  perf: PerformanceLike = performance,
): ForegroundRecoverySnapshot {
  return {
    nowMs: perf.now(),
    measureCount: perf.getEntriesByType('measure').length,
    markCount: perf.getEntriesByType('mark').length,
  };
}

export function clearPerformanceTimeline(perf: PerformanceLike = performance): void {
  perf.clearMeasures();
  perf.clearMarks();
}

export function installPerformanceTimelineCleanupInterval(
  target: PerformanceTimelineCleanupTarget = window,
  cleanup: () => void = () => clearPerformanceTimeline(),
): () => void {
  const existing = target[PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_KEY];
  if (existing !== undefined) {
    target.clearInterval(existing);
  }

  const intervalId = target.setInterval(cleanup, PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
  target[PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_KEY] = intervalId;

  return () => {
    target.clearInterval(intervalId);
    if (target[PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_KEY] === intervalId) {
      delete target[PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_KEY];
    }
  };
}

export function shouldRunForegroundRecoveryCleanup(
  snapshot: ForegroundRecoverySnapshot,
  hasHiddenStart: boolean,
): boolean {
  return (
    hasHiddenStart ||
    snapshot.measureCount >= PERFORMANCE_ENTRY_CLEANUP_THRESHOLD ||
    snapshot.markCount >= PERFORMANCE_ENTRY_CLEANUP_THRESHOLD
  );
}

function logForegroundRecovery(
  reason: 'focus' | 'visible',
  perf: PerformanceLike,
  hiddenAtMs: number | null,
  clearHiddenStart: () => void,
): void {
  const hasHiddenStart = hiddenAtMs !== null;
  if (hasHiddenStart) {
    const before = captureForegroundRecoverySnapshot(perf);
    clearHiddenStart();
    clearPerformanceTimeline(perf);
    const after = captureForegroundRecoverySnapshot(perf);
    const hiddenDurationMs = Math.max(0, Math.round(before.nowMs - hiddenAtMs));

    const payload = {
      reason,
      hiddenDurationMs,
      measureCountBefore: before.measureCount,
      markCountBefore: before.markCount,
      measureCountAfter: after.measureCount,
      markCountAfter: after.markCount,
    };

    if (hiddenDurationMs >= 5_000) {
      log.info('前台恢复清理', payload);
    } else {
      log.debug('前台恢复清理', payload);
    }
    return;
  }

  const before = captureForegroundRecoverySnapshot(perf);
  if (!shouldRunForegroundRecoveryCleanup(before, false)) return;

  clearPerformanceTimeline(perf);
  const after = captureForegroundRecoverySnapshot(perf);

  const payload = {
    reason,
    hiddenDurationMs: null,
    measureCountBefore: before.measureCount,
    markCountBefore: before.markCount,
    measureCountAfter: after.measureCount,
    markCountAfter: after.markCount,
  };

  if (
    before.measureCount >= PERFORMANCE_ENTRY_CLEANUP_THRESHOLD ||
    before.markCount >= PERFORMANCE_ENTRY_CLEANUP_THRESHOLD
  ) {
    log.info('前台恢复清理', payload);
  } else {
    log.debug('前台恢复清理', payload);
  }
}

export function disposeForegroundRecoveryDiagnostics(
  target: Pick<ForegroundRecoveryInstallTarget, 'window'> = { window },
): void {
  target.window[FOREGROUND_RECOVERY_DISPOSER_KEY]?.();
}

export function installForegroundRecoveryDiagnostics(
  target: ForegroundRecoveryInstallTarget = { document, window, performance },
): () => void {
  target.window[FOREGROUND_RECOVERY_DISPOSER_KEY]?.();
  let hiddenAtMs: number | null = null;

  const clearHiddenStart = (): void => {
    hiddenAtMs = null;
  };

  const handleVisibilityChange = (): void => {
    if (target.document.visibilityState === 'hidden') {
      hiddenAtMs = target.performance.now();
      return;
    }
    logForegroundRecovery('visible', target.performance, hiddenAtMs, clearHiddenStart);
  };

  const handleFocus = (): void => {
    logForegroundRecovery('focus', target.performance, hiddenAtMs, clearHiddenStart);
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.document.removeEventListener('visibilitychange', handleVisibilityChange);
    target.window.removeEventListener('focus', handleFocus);
    hiddenAtMs = null;
    if (target.window[FOREGROUND_RECOVERY_DISPOSER_KEY] === dispose) {
      delete target.window[FOREGROUND_RECOVERY_DISPOSER_KEY];
    }
  };

  target.document.addEventListener('visibilitychange', handleVisibilityChange);
  target.window.addEventListener('focus', handleFocus);
  target.window[FOREGROUND_RECOVERY_DISPOSER_KEY] = dispose;
  return dispose;
}
