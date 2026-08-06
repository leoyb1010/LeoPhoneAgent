import { AppState } from 'react-native';

/**
 * JS 线程停摆探测器(dev-only 取证工具)。
 * ---------------------------------------------------------------------------
 * 背景:手机端没有落盘日志,JS 线程被打满(microtask 风暴 / 长任务)时界面无响应、
 * 事后无从确认停摆的时间边界与时长(2026-07 会话页 microtask 风暴取证只能靠宿主机
 * 进程采样,无法与 Metro 日志流对齐)。这里用 1s 心跳计时器度量事件循环 tick 间隙:
 * JS 忙死时计时器不触发,恢复后首个 tick 的间隙即停摆时长,打一条 WARN 钉进日志流,
 * 与前后的业务日志(device-link 慢请求等)天然对齐。
 *
 * 噪声过滤:App 退后台时 iOS 挂起 JS 计时器,回前台会产生同样的长间隙——AppState
 * 非 active 期间不计,回前台重置基准。
 */

/** 心跳周期(ms)。 */
export const JS_STALL_TICK_MS = 1_000;

/** 默认时间源:优先单调时钟(不受系统校时回拨影响),没有 performance 时退回 Date.now(与 navigationLock 同款)。 */
function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** 超出心跳周期多少毫秒才算停摆并上报(过滤正常调度抖动)。 */
export const JS_STALL_REPORT_THRESHOLD_MS = 2_000;

/**
 * 超过该时长的间隙判为「疑似挂起」而非 JS 停摆:整机睡眠 / 进程冻结也会冻结计时器,
 * 实测(2026-07-18 夜间)Mac 睡眠的周期性维护唤醒会刷出成串 ~900-1080s 的假停摆,
 * 污染取证。真实 microtask 风暴实测量级为秒级到 ~90s,取 120s 为分界。
 */
export const JS_STALL_SUSPEND_SUSPECT_MS = 120_000;

/**
 * 纯判定:上个 tick 时刻 → 本 tick 时刻的间隙是否构成应上报的停摆。
 * 返回停摆时长(间隙中超出心跳周期的部分),不构成则返回 null。
 */
export function evaluateJsStallTick(prevTickAt: number, now: number): number | null {
  const stalledMs = now - prevTickAt - JS_STALL_TICK_MS;
  return stalledMs >= JS_STALL_REPORT_THRESHOLD_MS ? stalledMs : null;
}

/** 纯判定:停摆时长归类——真 JS 停摆,还是疑似整机睡眠 / 进程挂起。 */
export function classifyJsStallGap(stalledMs: number): 'stall' | 'suspend-suspect' {
  return stalledMs >= JS_STALL_SUSPEND_SUSPECT_MS ? 'suspend-suspect' : 'stall';
}

/**
 * 启动探测器,返回停止函数。生产构建为 no-op(纯取证工具,不进用户机器)。
 */
export function startJsStallWatchdog(
  report: (message: string) => void = (message) => console.warn(message),
): () => void {
  if (!__DEV__) return () => {};
  let prevTickAt = monotonicNow();
  const sub = AppState.addEventListener('change', (next) => {
    // 回前台重置基准:后台挂起产生的间隙不是 JS 停摆。
    if (next === 'active') prevTickAt = monotonicNow();
  });
  const timer = setInterval(() => {
    const now = monotonicNow();
    const stalledMs = AppState.currentState === 'active'
      ? evaluateJsStallTick(prevTickAt, now)
      : null;
    prevTickAt = now;
    if (stalledMs !== null) {
      const seconds = (stalledMs / 1000).toFixed(1);
      report(classifyJsStallGap(stalledMs) === 'suspend-suspect'
        ? `[js-stall] suspicious ~${seconds}s gap (likely system/process suspend, not a JS stall)`
        : `[js-stall] JS thread stalled ~${seconds}s (event-loop tick gap)`);
    }
  }, JS_STALL_TICK_MS);
  return () => {
    sub.remove();
    clearInterval(timer);
  };
}
