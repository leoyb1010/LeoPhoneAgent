/**
 * formatSidebarTime — Sidebar SessionItem 右侧最近活动时间的简短展示
 *
 * 规则参考 Codex Desktop projectless conversation 列表：
 *   - 1 分钟内：刚刚 / now
 *   - 1 小时内：N 分钟
 *   - 1 天内：N 小时
 *   - 1 周内：N 天
 *   - 1 月内：N 周
 *   - 1 年内：N 月
 *   - 更早：N 年
 *
 * 不带 hover-tick 逻辑——sidebar 几百条 session 全部都不动，刷新只在重新挂载/进入新一天时
 * 自然发生即可，不需要 setInterval。
 *
 * i18n: 调用方在 React 组件里把 t 函数传进来（i18next 不支持脱离 React 取 t）；
 *   未传 t 时退回到英文兜底，避免渲染层调用链路出错。
 */

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function tr(t: TFunc | undefined, key: string, fallback: string, options?: Record<string, unknown>): string {
  const value = t ? t(key, options) : '';
  return value && value !== key ? value : fallback;
}

export function formatSidebarTime(iso: string | undefined, t?: TFunc, now: Date = new Date()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';

  const diffMs = Math.max(0, now.getTime() - ms);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  if (diffMs < minuteMs) return tr(t, 'ccAgent.time.relative.now', 'now');
  if (diffMs < hourMs) {
    const count = Math.max(1, Math.floor(diffMs / minuteMs));
    return tr(t, 'ccAgent.time.relative.minute', `${count}m`, { count });
  }
  if (diffMs < dayMs) {
    const count = Math.max(1, Math.floor(diffMs / hourMs));
    return tr(t, 'ccAgent.time.relative.hour', `${count}h`, { count });
  }
  if (diffMs < weekMs) {
    const count = Math.max(1, Math.floor(diffMs / dayMs));
    return tr(t, 'ccAgent.time.relative.day', `${count}d`, { count });
  }
  if (diffMs < monthMs) {
    const count = Math.max(1, Math.floor(diffMs / weekMs));
    return tr(t, 'ccAgent.time.relative.week', `${count}w`, { count });
  }
  if (diffMs < yearMs) {
    const count = Math.max(1, Math.floor(diffMs / monthMs));
    return tr(t, 'ccAgent.time.relative.month', `${count}mo`, { count });
  }
  const count = Math.max(1, Math.floor(diffMs / yearMs));
  return tr(t, 'ccAgent.time.relative.year', `${count}y`, { count });
}

export function formatSidebarFutureTime(ms: number | undefined, t?: TFunc, now: Date = new Date()): string {
  if (!ms) return '';
  if (!Number.isFinite(ms)) return '';

  const diffMs = ms - now.getTime();
  if (diffMs <= 0) return '';
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;

  if (diffMs < minuteMs) {
    const count = Math.max(1, Math.ceil(Math.max(0, diffMs) / 1000));
    return tr(t, 'ccAgent.time.future.second', `in ${count}s`, { count });
  }
  if (diffMs < hourMs) {
    const count = Math.max(1, Math.floor(diffMs / minuteMs));
    return tr(t, 'ccAgent.time.future.minute', `in ${count}m`, { count });
  }
  if (diffMs < dayMs) {
    const count = Math.max(1, Math.floor(diffMs / hourMs));
    return tr(t, 'ccAgent.time.future.hour', `in ${count}h`, { count });
  }
  if (diffMs < weekMs) {
    const count = Math.max(1, Math.floor(diffMs / dayMs));
    return tr(t, 'ccAgent.time.future.day', `in ${count}d`, { count });
  }
  if (diffMs < monthMs) {
    const count = Math.max(1, Math.floor(diffMs / weekMs));
    return tr(t, 'ccAgent.time.future.week', `in ${count}w`, { count });
  }
  if (diffMs < yearMs) {
    const count = Math.max(1, Math.floor(diffMs / monthMs));
    return tr(t, 'ccAgent.time.future.month', `in ${count}mo`, { count });
  }
  const count = Math.max(1, Math.floor(diffMs / yearMs));
  return tr(t, 'ccAgent.time.future.year', `in ${count}y`, { count });
}

/** 完整时间 — 给 <time> title 属性用，鼠标悬停显示 ISO 风格的完整日期。 */
export function formatSidebarTimeAbsolute(iso: string | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
