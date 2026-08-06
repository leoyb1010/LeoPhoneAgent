/**
 * useAttachedSessionIds
 * ---------------------------------------------------------------------------
 * Sidebar-wide hook returning the Set of sessionIds currently attached to any
 * IM channel (i.e. being remote-controlled). SessionItem uses it to swap its
 * left status icon to a "radio tower" when attached, restore vendor mark on
 * detach.
 *
 * 数据流:
 *   1. mount: invoke binding:list-attached 拿全量快照 (一次性, 避免对每条
 *      session 各发 IPC)
 *   2. 订阅 binding:changed 增量更新 — main 端 attach/detach 一次推一条
 *
 * 单例: 整个 renderer 只有一个 sidebar 在用, 所以 hook 内部 state 自管即可,
 * 不需要外置 store。
 */

import { useEffect, useState } from 'react';

const EMPTY: ReadonlySet<string> = new Set();

export function useAttachedSessionIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const r = await window.electronAPI.binding.listAttached();
        if (cancelled) return;
        setIds(new Set(r.sessionIds));
      } catch {
        if (cancelled) return;
        setIds(EMPTY);
      }
    };

    void refresh();

    // 任何 binding:changed 都触发一次全量 refresh — 频率极低 (用户级 attach /
    // detach), 没必要做增量 add/delete 的精细化处理, 全量重拉简单可靠。
    const unsubscribe = window.electronAPI.binding.onChanged(() => {
      void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return ids;
}
