/**
 * monthlyClamp — Monthly preset 的"配置日不存在则 clamp 到月末"语义
 * ---------------------------------------------------------------------------
 * UI 的 Monthly preset 形态固定为 `MM HH D * *`（单一固定日，月/周通配）。
 * 标准 vixie-cron 语义会让"31 号 + 4 月（30 天）"整月跳过；这里把 D 自动
 * clamp 到 `min(D, daysInMonth(y,m))`，让用户每月都能跑上。
 *
 * Custom 模式手写的复杂 cron（含 list/range/DOW 限制等）不走这条路径，
 * 仍按标准 vixie-cron 语义跳过非匹配月份 —— 由 `tryParseMonthlyPreset`
 * 严格的形态校验来区分两边。
 *
 * scheduler 引擎统一调用 `nextCronOrMonthlyFire`：内部先 try 解析 monthly
 * preset，命中走 clamp 算法，否则 fallback 到 `nextRun`。
 */

import { wallClock, fromWallClock, nextRun } from './cron.js';

export interface MonthlyPreset {
  /** 0-59 */
  minute: number;
  /** 0-23 */
  hour: number;
  /** 1-31，配置日（实际触发时会 clamp 到月末） */
  day: number;
}

const NUM = /^\d+$/;

/** 严格匹配 `MM HH D * *` 形态；其它返回 null（fallback 到 nextRun）。 */
export function tryParseMonthlyPreset(expr: string): MonthlyPreset | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mm, hh, dom, mon, dow] = parts;
  if (mon !== '*' || dow !== '*') return null;
  if (!NUM.test(mm) || !NUM.test(hh) || !NUM.test(dom)) return null;
  const minute = Number(mm);
  const hour = Number(hh);
  const day = Number(dom);
  if (minute < 0 || minute > 59) return null;
  if (hour < 0 || hour > 23) return null;
  if (day < 1 || day > 31) return null;
  return { minute, hour, day };
}

/** 该月有多少天（month 为 1-12）。`Date.UTC(y, m, 0)` = 上月最后一天。 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 算 Monthly preset 的下次触发时间。语义：
 *   - actualDay = min(配置日, 该月最大天数)
 *   - candidate = 该年/月/actualDay 的 wall-clock HH:MM 在 tz 下的 epoch
 *   - 选第一个 `>= 当前分钟边界 + 1min` 的 candidate
 *     （与 nextRun 一致："严格未来"，命中当前这一分钟也跳过）
 */
export function nextMonthlyFire(preset: MonthlyPreset, fromMs: number, tz: string): number {
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const w = wallClock(startMs, tz);
  let y = w.y;
  let m = w.mo; // 1-12

  // 13 次足够：当前月 + 后续 12 个月，任何 D∈[1,31] 都能找到匹配。
  for (let i = 0; i < 13; i++) {
    const actualDay = Math.min(preset.day, daysInMonth(y, m));
    const candidate = fromWallClock(y, m, actualDay, preset.hour, preset.minute, tz);
    if (candidate >= startMs) return candidate;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  throw new Error(
    `nextMonthlyFire: no candidate within 13 months for day=${preset.day} from ${new Date(fromMs).toISOString()} in ${tz}`,
  );
}

/**
 * scheduler 用的统一入口。先 try monthly preset，命中走 clamp 算法；
 * 否则 fallback 到标准 cron 引擎。schedule.ts 所有 `nextRun(...)` 调用点统一走这个。
 */
export function nextCronOrMonthlyFire(expr: string, fromMs: number, tz: string): number {
  const preset = tryParseMonthlyPreset(expr);
  if (preset) return nextMonthlyFire(preset, fromMs, tz);
  return nextRun(expr, fromMs, tz);
}
