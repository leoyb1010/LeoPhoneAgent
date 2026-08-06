import { useEffect } from 'react';

import { useAppShortcut } from './useAppShortcut';

/**
 * mac ⌘W 的根级"纯关窗"兜底 —— Window > Close 菜单项不再注册 accelerator 后
 * ('close-tab-or-window' 方案),⌘W 完全依赖 renderer 监听。壳层
 * (MainLayout / SidebarWindowLayout) 有自己的焦点分派消费点 (右侧栏 tab 优先),
 * 但 splash / env check / 登录 / 迁移这些壳外阶段没有任何监听,⌘W 会失效。
 *
 * 方案:App 根挂 useCloseWindowFallbackShortcut (永远在,包括 splash 阶段);
 * 壳层挂载期间通过 useCloseShortcutShellOwner 声明所有权,兜底让路 (返回
 * false 不消费,同一 window capture 阶段后注册的壳层监听随后消费)。模块级
 * 计数器,纯代码判定,无监听注册顺序依赖。
 */

let shellOwnerCount = 0;

/** 壳层布局 (MainLayout / SidebarWindowLayout) 挂载期间声明 ⌘W 所有权。 */
export function useCloseShortcutShellOwner(): void {
  useEffect(() => {
    shellOwnerCount += 1;
    return () => {
      shellOwnerCount -= 1;
    };
  }, []);
}

/** App 根级兜底:无壳层所有者时 darwin ⌘W 关(隐藏)本窗口,对齐原生 role close。
 *  win/linux 不消费 (Ctrl+W 在窗口层历史上无绑定,主窗关闭 = 退出 app)。 */
export function useCloseWindowFallbackShortcut(): void {
  useAppShortcut('close-tab-or-window', () => {
    if (shellOwnerCount > 0) return false;
    if (window.electronAPI?.platform !== 'darwin') return false;
    window.electronAPI.windowCloseSelf();
    return true;
  });
}
