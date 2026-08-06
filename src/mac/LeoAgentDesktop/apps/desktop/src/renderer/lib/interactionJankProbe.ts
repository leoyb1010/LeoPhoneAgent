import { createLogger } from '@/lib/logger';

const log = createLogger('perf/interaction');

/**
 * 交互卡顿探针(dev-only 诊断) —— 2026-07-20 会话切换体感卡顿归因:
 * 既有探针覆盖不到"点击→挂载"之间与首帧之后的主线程长任务
 * (render-watchdog 阈值 3s 太粗;perf/session-switch 只测 MessageStream
 * mount→first-paint),体感 ~1s 的卡顿在两者的盲区里。本模块把盲区变成日志:
 *
 * 1. longtask 观测 —— 主线程单个任务 ≥100ms 即记录(时长 + 发生时刻),
 *    与 sidebar:click / stream:mount 日志按时间戳对齐即可看出卡在哪一段。
 * 2. Event Timing 观测 —— pointerdown / click / keydown 的 input→下一帧
 *    总时长 ≥150ms 即记录(含 inputDelay = 事件排队等待主线程的时间),
 *    这是"点下去多久才有反应"的直接度量。
 *
 * 性能:两个被动 PerformanceObserver,无轮询、无动画,不违反设计规范规则 7。
 * 仅 dev 构建安装(index.tsx 里 import.meta.env.DEV 守卫),对正式包零影响。
 */
const LONG_TASK_LOG_THRESHOLD_MS = 100;
const SLOW_EVENT_LOG_THRESHOLD_MS = 150;
/** Event Timing 观测的事件类型白名单 —— 只关心离散输入,忽略 pointermove 等高频事件。 */
const OBSERVED_EVENT_TYPES = new Set(['pointerdown', 'pointerup', 'click', 'keydown']);
/** 防刷屏:每 10s 窗口内两类日志合计最多 40 条,超出静默丢弃(窗口结束时补一条计数)。 */
const LOG_WINDOW_MS = 10_000;
const LOG_WINDOW_MAX = 40;

interface PerformanceEventTimingLike extends PerformanceEntry {
  processingStart?: number;
  interactionId?: number;
  target?: Node | null;
}

export function installInteractionJankProbe(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};

  let windowStartedAt = 0;
  let windowCount = 0;
  let windowDropped = 0;

  /** 限流闸:返回 true 表示本条可以打;窗口翻转时把上一窗被丢的条数补报出来。 */
  const admitLog = (now: number): boolean => {
    if (now - windowStartedAt >= LOG_WINDOW_MS) {
      if (windowDropped > 0) {
        log.debug(`probe:log-window dropped=${windowDropped} (rate-limited)`);
      }
      windowStartedAt = now;
      windowCount = 0;
      windowDropped = 0;
    }
    if (windowCount >= LOG_WINDOW_MAX) {
      windowDropped += 1;
      return false;
    }
    windowCount += 1;
    return true;
  };

  const observers: PerformanceObserver[] = [];

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_LOG_THRESHOLD_MS) continue;
        if (!admitLog(now)) continue;
        log.debug(
          `longtask dur=${Math.round(entry.duration)}ms start=${Math.round(entry.startTime)}`,
        );
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: false });
    observers.push(longTaskObserver);
  } catch {
    // longtask 观测在个别环境不可用 —— 探针缺一半仍有价值,静默降级。
  }

  try {
    const eventObserver = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries() as PerformanceEventTimingLike[]) {
        if (!OBSERVED_EVENT_TYPES.has(entry.name)) continue;
        if (entry.duration < SLOW_EVENT_LOG_THRESHOLD_MS) continue;
        if (!admitLog(now)) continue;
        const inputDelay =
          entry.processingStart !== undefined
            ? Math.round(entry.processingStart - entry.startTime)
            : -1;
        const targetDesc =
          entry.target instanceof Element
            ? `${entry.target.tagName.toLowerCase()}${entry.target.id ? `#${entry.target.id}` : ''}`
            : 'detached';
        log.debug(
          `slow-event type=${entry.name} dur=${Math.round(entry.duration)}ms inputDelay=${inputDelay}ms start=${Math.round(entry.startTime)} target=${targetDesc}`,
        );
      }
    });
    // durationThreshold 下限 16ms;阈值过滤在回调里做,这里给个较低值确保能收到条目。
    eventObserver.observe({ type: 'event', buffered: false, durationThreshold: 96 } as PerformanceObserverInit);
    observers.push(eventObserver);
  } catch {
    // Event Timing 不可用同样静默降级。
  }

  return () => {
    for (const observer of observers) observer.disconnect();
  };
}
