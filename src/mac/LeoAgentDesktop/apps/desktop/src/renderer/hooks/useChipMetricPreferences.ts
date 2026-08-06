/**
 * useChipMetricPreferences — 控制右下角 TodaySpendChip (Claude 形态) 直接显示哪些指标。
 *
 * 3 个候选指标:
 *   - daily: 今日跨客户端已用 / 软日限额
 *   - monthly: 本月度周期已用 / 月度上限
 *   - session: 当前 session 终身累计
 *
 * 持久化: localStorage key 'chip.metrics.selected', JSON 数组。
 * 默认: ['daily', 'session'] — 匹配重构前 chip 的视觉行为 (Today + Session)。
 * 注: 曾有 'curApp' (当前 API key 今日) 候选, 因口径冗余 + key 归属取错桶, 2026-06-21 移除。
 *     isValidKey 会自动过滤掉旧用户 localStorage 里残留的 'curApp' 勾选, 无需额外迁移。
 *
 * 配套: TodaySpendChip 用 selected 决定 chip 段, 把"未选中"的指标排进 tooltip。
 */

import { useCallback, useEffect, useState } from 'react';

export const CHIP_METRIC_KEYS = ['daily', 'monthly', 'session'] as const;
export type ChipMetricKey = (typeof CHIP_METRIC_KEYS)[number];

const STORAGE_KEY = 'chip.metrics.selected';
const CHANGE_EVENT = 'chip-metrics-selected-changed';
const DEFAULT_SELECTED: ChipMetricKey[] = ['daily', 'session'];

function isValidKey(v: unknown): v is ChipMetricKey {
  return typeof v === 'string' && (CHIP_METRIC_KEYS as readonly string[]).includes(v);
}

/** 同步读取 (非 hook 路径用)。坏数据 / 缺失 → 默认值。 */
export function getChipMetricsSelected(): ChipMetricKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return [...DEFAULT_SELECTED];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SELECTED];
    const filtered = parsed.filter(isValidKey);
    // 去重保序: CHIP_METRIC_KEYS 顺序决定 chip 段顺序, 这里按声明顺序整理。
    return CHIP_METRIC_KEYS.filter((k) => filtered.includes(k));
  } catch {
    return [...DEFAULT_SELECTED];
  }
}

export function useChipMetricPreferences(): {
  selected: ChipMetricKey[];
  toggle: (key: ChipMetricKey) => void;
  isSelected: (key: ChipMetricKey) => boolean;
} {
  const [selected, setSelectedState] = useState<ChipMetricKey[]>(getChipMetricsSelected);

  const toggle = useCallback(
    (key: ChipMetricKey) => {
      setSelectedState((prev) => {
        const next = prev.includes(key)
          ? prev.filter((k) => k !== key)
          : CHIP_METRIC_KEYS.filter((k) => prev.includes(k) || k === key);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        window.dispatchEvent(new Event(CHANGE_EVENT));
        return next;
      });
    },
    [],
  );

  const isSelected = useCallback(
    (key: ChipMetricKey) => selected.includes(key),
    [selected],
  );

  // 跨组件实例 / 跨窗口同步 — Settings 改了 chip 立刻跟上, 反之亦然。
  useEffect(() => {
    const sync = () => setSelectedState(getChipMetricsSelected());
    const storageHandler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      sync();
    };
    window.addEventListener('storage', storageHandler);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', storageHandler);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  return { selected, toggle, isSelected };
}
