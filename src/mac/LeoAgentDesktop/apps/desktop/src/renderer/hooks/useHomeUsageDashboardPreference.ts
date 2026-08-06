/**
 * useHomeUsageDashboardPreference — 控制首页(新建对话界面)「用量与开销」仪表盘
 * (HomeUsageDashboard 整块: 统计条 + 热力图 + 每日柱状图) 是否显示。
 *
 * 与右下角 chip 的指标偏好 (useChipMetricPreferences) 是两套独立偏好, 互不影响。
 *
 * 持久化: localStorage key 'home.usageDashboard.enabled', JSON boolean。
 * 默认: true — 保持现状(此前为无条件渲染), 缺失 / 坏数据都回退为开启。
 *
 * 隐性偏好: 刻意不在设置页暴露可见开关 (避免设置页为低频偏好无限扩张)。
 * 关闭途径为带外操作 —— 由 agent (或未来统一的自定义设置 skill) 调用 setEnabled
 * 写 key 并派发 CHANGE_EVENT, 首页即时响应。setEnabled 即为该程序化入口。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'home.usageDashboard.enabled';
const CHANGE_EVENT = 'home-usage-dashboard-enabled-changed';
const DEFAULT_ENABLED = true;

/** 同步读取 (非 hook 路径用)。坏数据 / 缺失 → 默认开启。 */
export function getHomeUsageDashboardEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_ENABLED;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : DEFAULT_ENABLED;
  } catch {
    return DEFAULT_ENABLED;
  }
}

export function useHomeUsageDashboardPreference(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getHomeUsageDashboardEnabled);

  const setEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setEnabledState(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  // 跨组件实例 / 跨窗口同步 — Settings 改了, 首页立刻跟上, 反之亦然。
  useEffect(() => {
    const sync = () => setEnabledState(getHomeUsageDashboardEnabled());
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

  return { enabled, setEnabled };
}
