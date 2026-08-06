/**
 * useFeishuNotificationSettings — 飞书通知开关。
 * ---------------------------------------------------------------------------
 * 与 useNotificationSettings 同构：localStorage 单一 boolean,默认 false。
 *   - key:     `notifications.feishuEnabled`
 *   - default: false  (新增渠道,需要用户主动开启 + 飞书 bot 已绑定 owner)
 *
 * 同窗口同进程的 `storage` 事件不会自发 fire (web API 限制),所以这里维护一份
 * 模块级 subscribers,setter 写完 localStorage 后手动 broadcast,任何调用方都
 * 能让所有挂着 hook 的实例同步。跨 window 仍走原生 `storage` 事件。
 *
 * 暴露的模块级 setter `setFeishuNotificationsEnabled` 让"解绑 bot 后自动关
 * 飞书通知开关"这类副作用不必跨 React 组件传递 setter——任何位置 import 即可。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'notifications.feishuEnabled';
const DEFAULT_ENABLED = false;

// 模块级 subscribers — useFeishuNotificationSettings mount 时注册,setter 通知。
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

/** 同步读 localStorage——给非 hook 路径用。坏数据当默认值。 */
export function getFeishuNotificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用——退回默认。
  }
  return DEFAULT_ENABLED;
}

/**
 * 模块级 setter — 同步写 localStorage 并 broadcast 给所有 hook 实例。
 *
 * 跟 React 状态解耦,适合在副作用路径调用 (例如 useFeishuBot.clear() 解绑 bot
 * 后顺手把开关落到 false,避免"幽灵 true 状态"导致的 main 侧 warn 噪音和
 * UI disabled 后用户无法手动关闭)。
 */
export function setFeishuNotificationsEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // localStorage 不可用——忽略,UI 仍以内存值为准。
  }
  notifySubscribers();
}

export function useFeishuNotificationSettings(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getFeishuNotificationsEnabled);

  const setEnabled = useCallback((next: boolean) => {
    setFeishuNotificationsEnabled(next);
  }, []);

  useEffect(() => {
    const onChange = () => setEnabledState(getFeishuNotificationsEnabled());
    subscribers.add(onChange);
    // 跨 window/tab 走原生 storage 事件;同窗口靠 module subscribers。
    window.addEventListener('storage', onChange);
    return () => {
      subscribers.delete(onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return { enabled, setEnabled };
}
