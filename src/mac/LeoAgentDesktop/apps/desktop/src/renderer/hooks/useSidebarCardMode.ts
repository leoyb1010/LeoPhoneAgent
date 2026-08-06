/**
 * useSidebarCardMode — 侧边栏置顶段"显示模式"(sidebar-card-mode redesign)。
 * ---------------------------------------------------------------------------
 * 三态模式(替代原 boolean cardMode):
 *   - 'text'  文字版:紧凑行(SessionItem),默认。
 *   - 'card'  卡片版:卡片瀑布流(SessionCard),列数随侧栏宽度 1/2/3 自适应。
 *   - 'list'  列表:卡片视觉但**单列满宽**(不分栏、不受宽度限制铺满左侧,类灵动岛)。
 *
 * localStorage key 仍用 `sidebar.cardMode`(向后兼容):写入 'text'|'card'|'list';
 * 读取时兼容旧 boolean 字符串('true'→'card','false'→'text')。
 * 模块级内存值做跨实例 SoT;`storage` 事件做跨窗口同步(同 useNotificationSettings 模式)。
 */

import { useCallback, useEffect, useState } from 'react';

export type SidebarViewMode = 'text' | 'card' | 'list';

const STORAGE_KEY = 'sidebar.cardMode';
const DEFAULT_MODE: SidebarViewMode = 'text';

/** 解析存储值;兼容旧 boolean 字符串。无法识别返回 null(由调用方落默认)。 */
function parseMode(raw: string | null): SidebarViewMode | null {
  if (raw === 'text' || raw === 'card' || raw === 'list') return raw;
  if (raw === 'true') return 'card'; // 旧版 cardMode=true
  if (raw === 'false') return 'text'; // 旧版 cardMode=false
  return null;
}

/**
 * 模块级内存值 = 跨实例 SoT。一旦被 setMode 或 storage 事件写定,getSidebarViewMode
 * 即返回它、不再回读 localStorage——localStorage 写失败时 listener 回读也拿内存新值,
 * 不会把刚切换的窗口又改回旧值(切换静默失效 bug)。初始 null:首个读取者落定一次。
 */
let memoryValue: SidebarViewMode | null = null;

/** 同步读——给非 hook 路径用。 */
export function getSidebarViewMode(): SidebarViewMode {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parseMode(localStorage.getItem(STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_MODE;
}

/** 同标签页内的实例间同步(原生 storage 事件只发给其它窗口)。 */
const listeners = new Set<() => void>();

export function useSidebarCardMode(): {
  mode: SidebarViewMode;
  setMode: (next: SidebarViewMode) => void;
} {
  const [mode, setModeState] = useState<SidebarViewMode>(getSidebarViewMode);

  const setMode = useCallback((next: SidebarViewMode) => {
    // 先写内存 SoT,再 setState + 通知 listener——即便下面 setItem 抛错,本窗口也不会
    // 被 listener 回读旧 storage 改回去(切换静默失效 bug)。
    memoryValue = next;
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setModeState(getSidebarViewMode());
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      memoryValue = parseMode(e.newValue) ?? DEFAULT_MODE;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { mode, setMode };
}
