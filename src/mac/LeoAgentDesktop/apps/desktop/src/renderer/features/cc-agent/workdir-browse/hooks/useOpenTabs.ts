/**
 * useOpenTabs — 订阅 openTabsStore，对外暴露当前 workdir 的 tab 列表 + 操作方法。
 *
 * 与 store 的关系：
 *   - store 是 SSOT（模块级 singleton + localStorage）；
 *   - 本 hook 只是「读快照 + 订阅变化 + 暴露 stable callback」的薄壳；
 *   - 多个组件实例共享同一份 store，互相之间会自动同步。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  addTab as storeAddTab,
  closeTabs as storeCloseTabs,
  getTabs,
  removeTab as storeRemoveTab,
  reorderTabs as storeReorderTabs,
  subscribe,
} from '../lib/openTabsStore';

export interface UseOpenTabsReturn {
  /** 当前 workdir 已打开的 tab 列表（按显示顺序）。 */
  tabs: string[];
  /** 末尾追加；已存在则 no-op。 */
  addTab: (relPath: string) => void;
  /** 删除指定 tab；不存在则 no-op。 */
  removeTab: (relPath: string) => void;
  /** 批量关闭。返回真正被关掉的 path(用于 caller 清 scroll cache 等)。 */
  closeTabs: (paths: readonly string[]) => string[];
  /** 把 fromIdx 处的 tab 移到 toIdx；用于拖拽重排。 */
  reorderTabs: (fromIdx: number, toIdx: number) => void;
}

export function useOpenTabs(workdir: string): UseOpenTabsReturn {
  const [tabs, setTabs] = useState<string[]>(() => getTabs(workdir));

  useEffect(() => {
    // workdir 变化（用户切到了别的 project）时，立刻 swap 到新桶的快照。
    setTabs(getTabs(workdir));
    return subscribe((wd) => {
      if (wd === workdir) setTabs(getTabs(workdir));
    });
  }, [workdir]);

  const addTab = useCallback((relPath: string) => storeAddTab(workdir, relPath), [workdir]);
  const removeTab = useCallback((relPath: string) => storeRemoveTab(workdir, relPath), [workdir]);
  const closeTabs = useCallback(
    (paths: readonly string[]) => storeCloseTabs(workdir, paths),
    [workdir],
  );
  const reorderTabs = useCallback(
    (fromIdx: number, toIdx: number) => storeReorderTabs(workdir, fromIdx, toIdx),
    [workdir],
  );

  return { tabs, addTab, removeTab, closeTabs, reorderTabs };
}
