import type { RateWindow, UsagePace } from './ai-quota.types.js';

/**
 * [T-quota-bar] 配速模型。公式照搬 CodexBar 的 UsagePace(MIT,见 NOTICE)。
 *
 *   duration        = windowMinutes × 60
 *   timeUntilReset  = resetsAt − now         (必须 >0 且 ≤duration,否则给不出结论)
 *   elapsed         = duration − timeUntilReset
 *   expectedUsed%   = elapsed / duration × 100
 *   actualUsed%     = clamp(usedPercent, 0..100)
 *   delta           = actual − expected      (>0 = 超前消耗,赤字)
 *   rate            = actual / elapsed       (每秒烧掉几个百分点)
 *   etaSeconds      = (100 − actual) / rate
 *   speedMultiplier = (100 − actual) / (rate × timeUntilReset)
 *
 * 两处刻意的"不给结论":
 *  - `timeUntilReset` 落在窗口长度之外,说明 resetsAt 和 windowMinutes 对不上
 *    (陈旧的日志帧最常见),这时候算出来的 expected 是错的,直接返回 null。
 *  - 窗口才刚开(expected < 3%),分母太小,任何一点用量都会被放大成"严重超支"。
 *    宁可不显示,也不摆一个吓人的假结论。
 */

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 窗口刚开时分母太小,配速没有参考价值,整体隐藏。 */
const MIN_EXPECTED_PERCENT = 3;

function stageFor(delta: number): UsagePace['stage'] {
  const magnitude = Math.abs(delta);
  if (magnitude <= 2) return 'onTrack';
  if (magnitude <= 6) return delta >= 0 ? 'slightlyAhead' : 'slightlyBehind';
  if (magnitude <= 12) return delta >= 0 ? 'ahead' : 'behind';
  return delta >= 0 ? 'farAhead' : 'farBehind';
}

/**
 * 按当前速率外推到重置时刻,超出 100% 的部分就是"耗尽风险"。
 * 取整到 5% —— 这是个启发式外推,报到个位数是假精度。
 */
function riskFor(projectedUsedPercent: number): number {
  const overshoot = clamp(projectedUsedPercent - 100, 0, 100);
  return Math.round(overshoot / 5) * 5;
}

/** 算不出结论时返回 null,而不是返回一个"看起来正常"的零值。 */
export function computeUsagePace(window: RateWindow, nowMs: number = Date.now()): UsagePace | null {
  // 占位窗口没有真实用量,拿它算配速等于凭空造结论。
  if (window.isSyntheticPlaceholder) return null;
  const minutes = window.windowMinutes;
  if (!minutes || minutes <= 0) return null;
  if (!window.resetsAt) return null;

  const duration = minutes * 60;
  const timeUntilReset = (window.resetsAt - nowMs) / 1000;
  if (timeUntilReset <= 0 || timeUntilReset > duration) return null;

  const elapsed = duration - timeUntilReset;
  const expected = clamp((elapsed / duration) * 100, 0, 100);
  if (expected < MIN_EXPECTED_PERCENT) return null;

  const actual = clamp(window.usedPercent, 0, 100);
  const remaining = 100 - actual;
  const rate = actual / elapsed;
  const projectedRemainingUsage = rate * timeUntilReset;

  let etaSeconds: number | null = null;
  let willLastToReset = false;
  let speedMultiplier: number | null = null;

  if (actual >= 100) {
    // 已经烧光了,没有"还能撑多久"可言。
    etaSeconds = 0;
    speedMultiplier = 0;
  } else if (rate > 0) {
    etaSeconds = remaining / rate;
    willLastToReset = etaSeconds >= timeUntilReset;
    speedMultiplier = projectedRemainingUsage > 0 ? remaining / projectedRemainingUsage : null;
  } else {
    // 一点没用:当然撑得到重置。倍数是无穷大,不编一个数字塞进去。
    willLastToReset = true;
  }

  return {
    stage: stageFor(actual - expected),
    deltaPercent: actual - expected,
    expectedUsedPercent: expected,
    etaSeconds,
    willLastToReset,
    speedMultiplier,
    riskPercent: riskFor(actual + projectedRemainingUsage),
  };
}
