/**
 * useChatRailCollapsed — collapse state for the workdir-browse view's RIGHT
 * chat rail. localStorage 持久化, 跨 session 记得用户上次的折叠偏好。
 *
 * 折叠行为(对标 MainLayout 的 SIDEBAR_COLLAPSED_KEY):
 *   - true  → rail 容器 width 收到 0 + transition-[width] 动画(动效跟左 sidebar
 *             折叠完全一致), chat 子树自然被宽度裁掉。
 *   - false → 恢复到 useChatRailResize 持久化的宽度。
 *
 * 跟 useChatRailResize 解耦:resize 管"展开后多宽", collapse 管"是否展开",
 * 两件事互不干扰; 用户在折叠态下不能拖宽度(handle 会被宿主隐藏)。
 */

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'cc-agent.workdirBrowse.chatRailCollapsed.v1';

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function useChatRailCollapsed() {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage 不可用 — 静默降级, 仍维护 in-memory 切换。
      }
      return next;
    });
  }, []);

  return { collapsed, toggle } as const;
}
