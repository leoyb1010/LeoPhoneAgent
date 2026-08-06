/**
 * useLinkOpenPreference — 消息流链接 / HTML 文件左键的"默认打开方式"偏好。
 * ---------------------------------------------------------------------------
 * 两态:
 *   - 'sidebar'   内置侧边栏浏览器(系统默认值)。
 *   - 'external'  系统默认浏览器。
 *
 * 规则 20(配置默认值 vs override)落法:localStorage 只存 override——
 * 用户选回 'sidebar'(= 当前系统默认)时**删除** key 而不是写入,这样未自定义
 * 的用户未来能自动跟随新版本默认值;isCustomized 即 "存在 override"。
 *
 * 模块级内存值做跨实例 SoT + `storage` 事件跨窗口同步,模式与
 * useSidebarCardMode 完全一致(localStorage 写失败时切换不静默回跳)。
 * 消息流点击 handler 走同步读 getLinkOpenPreference(),不需要订阅重渲。
 */

import { useCallback, useEffect, useState } from 'react';

export type LinkOpenPreference = 'sidebar' | 'external';

const STORAGE_KEY = 'chat.linkOpenPreference';
const DEFAULT_PREFERENCE: LinkOpenPreference = 'sidebar';

function parsePreference(raw: string | null): LinkOpenPreference | null {
  return raw === 'sidebar' || raw === 'external' ? raw : null;
}

/** 模块级内存 SoT;null = 尚未被本窗口读定/写定。 */
let memoryValue: LinkOpenPreference | null = null;

/** 同步读——给消息流点击 handler 等非 hook 路径用。 */
export function getLinkOpenPreference(): LinkOpenPreference {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parsePreference(localStorage.getItem(STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_PREFERENCE;
}

const listeners = new Set<() => void>();

export function useLinkOpenPreference(): {
  preference: LinkOpenPreference;
  /** 是否存在用户 override(≠ 系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setPreference: (next: LinkOpenPreference) => void;
} {
  const [preference, setState] = useState<LinkOpenPreference>(getLinkOpenPreference);

  const setPreference = useCallback((next: LinkOpenPreference) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_PREFERENCE) {
        // 选回默认 = 清除 override(而非写入默认值快照)。
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getLinkOpenPreference());
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      memoryValue = parsePreference(e.newValue) ?? DEFAULT_PREFERENCE;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { preference, isCustomized: preference !== DEFAULT_PREFERENCE, setPreference };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetLinkOpenPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}
