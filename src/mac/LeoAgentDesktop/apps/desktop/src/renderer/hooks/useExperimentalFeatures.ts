/**
 * useExperimentalFeatures — 实验功能开关，统一入口。
 *
 * 设计：
 * - 每个 feature 一个 boolean，默认全 off（实验功能必须显式 opt-in）
 * - localStorage key = 'experimental.<feature>'
 * - 跨组件实例同步走 storage 事件（同 useNotificationSettings 模式）
 *
 * 新增 experimental feature 只需要：
 * 1. 在 EXPERIMENTAL_FEATURES 加一项
 * 2. 在 ExperimentalSection 里加一行 UI
 */

import { useCallback, useEffect, useState } from 'react';

export interface ExperimentalFeatureMeta {
  /** localStorage key 后缀，最终 key = 'experimental.<key>' */
  key: string;
  /** UI 显示的标题 */
  title: string;
  /** UI 显示的副标题/描述 */
  description: string;
  /** 启用后的"打开"按钮配置（可选 —— 不是所有 feature 都有独立入口） */
  openAction?: {
    label: string;
    /** hash 路由路径，例 '/maker-experimental' */
    routePath: string;
  };
}

/**
 * 实验功能注册表。新 feature 在这里追加一项即可。
 */
// 整个 Experimental 区块仅 admin 用户可见 (在 ExperimentalSection 顶层 gate, 不在
// 单项上加 adminOnly)。新加 experimental feature 直接 push 到这个数组即可,
// 自动继承 admin-only 可见策略, 不需要再做权限相关声明。
// 数组为空时 ExperimentalSection 自动隐藏 (length === 0 早退)。
export const EXPERIMENTAL_FEATURES: ReadonlyArray<ExperimentalFeatureMeta> = [];

const KEY_PREFIX = 'experimental.';

function storageKey(featureKey: string): string {
  return `${KEY_PREFIX}${featureKey}`;
}

/** 同步读：给非 hook 路径用（例如条件渲染 sidebar 入口）。坏数据当默认值 false。 */
export function getExperimentalFlag(featureKey: string): boolean {
  try {
    const raw = localStorage.getItem(storageKey(featureKey));
    return raw === 'true';
  } catch {
    return false;
  }
}

/** 单 feature hook —— 返回 [enabled, setEnabled] 元组风格 */
export function useExperimentalFlag(featureKey: string): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(() => getExperimentalFlag(featureKey));

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(storageKey(featureKey), String(next));
    } catch {
      // localStorage 不可用 —— 忽略
    }
  }, [featureKey]);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== storageKey(featureKey)) return;
      setEnabledState(getExperimentalFlag(featureKey));
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [featureKey]);

  return { enabled, setEnabled };
}
