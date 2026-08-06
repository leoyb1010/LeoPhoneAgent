/**
 * useCollapsedProjects — Sidebar Project 折叠状态管理
 * ---------------------------------------------------------------------------
 * - localStorage key: `cc-agent.sidebar.collapsedProjects`
 * - 默认展开（无条目 = 展开）；仅持久化已折叠项
 * - mount 时执行一次 30 天 GC（清理 lastSeenAt 过期且不在当前 active 集合的项）
 *
 * API:
 *   collapsed         Set<string> — 当前所有折叠的 workingDir
 *   toggle(dir)       折叠/展开单项
 *   collapseAll()     把 activeWorkingDirs 全部塞入折叠集
 *   expandAll()       把 activeWorkingDirs 从折叠集移除
 *   isAllCollapsed    activeWorkingDirs 是否全部都折叠
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '@/lib/logger';
import { normalizeProjectKey } from '../lib/projectGrouping';

const log = createLogger('UseCollapsedProjects');

const STORAGE_KEY = 'cc-agent.sidebar.collapsedProjects';
const GC_DAYS = 30;
const GC_MS = GC_DAYS * 24 * 60 * 60 * 1000;

interface StoredEntry {
  /** 标记折叠态——只存折叠项，展开项从 stored 中删除 */
  collapsed: true;
  /** ISO 8601 — 上次写入时间，用于 GC 判定 */
  lastSeenAt: string;
}

type Stored = Record<string, StoredEntry>;

interface UseCollapsedProjectsReturn {
  collapsed: Set<string>;
  toggle: (projectKeyOrWorkingDir: string) => void;
  /** 幂等展开单项：已展开则 no-op。用于"新 session 进折叠 Project 时自动展开"等场景。 */
  expand: (projectKeyOrWorkingDir: string) => void;
  setCollapsed: (projectKeyOrWorkingDir: string, collapsed: boolean) => void;
  collapseAll: () => void;
  expandAll: () => void;
  isAllCollapsed: boolean;
}

function loadFromStorage(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 浅校验：保留具有 collapsed=true 的条目
      const out: Stored = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          const entry = v as Partial<StoredEntry>;
          if (entry.collapsed === true && typeof entry.lastSeenAt === 'string') {
            const projectKey = normalizeProjectKey(k);
            if (projectKey) {
              out[projectKey] = { collapsed: true, lastSeenAt: entry.lastSeenAt };
            }
          }
        }
      }
      return out;
    }
    return {};
  } catch (err) {
    // JSON parse / localStorage 异常 → 静默回退
    log.warn('failed to load stored state:', err);
    return {};
  }
}

function writeToStorage(next: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // quota exceeded / private mode 等 → 当前会话仍生效，console.warn 一次
    log.warn('failed to write stored state:', err);
  }
}

export function useCollapsedProjects(
  activeWorkingDirs: readonly string[],
): UseCollapsedProjectsReturn {
  const [stored, setStored] = useState<Stored>(() => loadFromStorage());

  // 用 ref 镜像最新的 activeWorkingDirs，让 toggle/collapseAll/expandAll 都能
  // 走"依赖空数组 + 闭包内读 ref.current"的统一模式，避免在 activeWorkingDirs
  // 引用变化时反复重建回调（统一策略，见 reviewer Minor #2）。
  const activeDirsRef = useRef<readonly string[]>(activeWorkingDirs);
  activeDirsRef.current = activeWorkingDirs;

  // mount 时 GC：清理 lastSeenAt 过期且不在 active 集合的条目
  // 仅 mount 一次（依赖空数组）—— GC 是低频清理，无需每次 active 变化都跑
  // ADR-4：useEffect 内部通过 activeDirsRef 读取最新值；依赖空数组属于
  // "故意只跑一次"。
  // why-deps-empty: activeWorkingDirs 故意通过 ref 读取，避免 mount 后再次
  //   触发 GC。当前项目未启用 eslint-plugin-react-hooks；若未来引入该插件，
  //   需要在此处加 `// eslint-disable-next-line react-hooks/exhaustive-deps`。
  useEffect(() => {
    const cutoff = Date.now() - GC_MS;
    const activeSet = new Set(activeDirsRef.current);
    setStored((prev) => {
      const next: Stored = {};
      let changed = false;
      for (const [dir, entry] of Object.entries(prev)) {
        const lastSeen = new Date(entry.lastSeenAt).getTime();
        const fresh = Number.isFinite(lastSeen) && lastSeen >= cutoff;
        if (fresh || activeSet.has(dir)) {
          next[dir] = entry;
        } else {
          changed = true;
        }
      }
      if (changed) {
        writeToStorage(next);
        return next;
      }
      return prev;
    });
  }, []);

  const collapsed = useMemo(() => new Set(Object.keys(stored)), [stored]);

  // toggle 不读取任何外部 state（只读 setStored 的 prev 闭包参数），故依赖空数组
  // 是稳定且必要的 —— 让回调引用永不重建，方便父组件 memo。
  // why-deps-empty: 仅通过 setStored prev 读 state，无外部依赖；hooks 插件未来
  //   启用时需加 `// eslint-disable-next-line react-hooks/exhaustive-deps`。
  const toggle = useCallback((projectKeyOrWorkingDir: string) => {
    const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
    if (!projectKey) return;
    setStored((prev) => {
      const next: Stored = { ...prev };
      if (next[projectKey]) {
        delete next[projectKey];
      } else {
        next[projectKey] = { collapsed: true, lastSeenAt: new Date().toISOString() };
      }
      writeToStorage(next);
      return next;
    });
  }, []);

  // 幂等展开：仅当目标目录当前在折叠集中时才写入，避免无意义的 setState/写盘。
  // why-deps-empty: 仅通过 setStored prev 读 state，无外部依赖；hooks 插件未来
  //   启用时需加 `// eslint-disable-next-line react-hooks/exhaustive-deps`。
  const expand = useCallback((projectKeyOrWorkingDir: string) => {
    const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
    if (!projectKey) return;
    setStored((prev) => {
      if (!prev[projectKey]) return prev;
      const next: Stored = { ...prev };
      delete next[projectKey];
      writeToStorage(next);
      return next;
    });
  }, []);

  const setCollapsed = useCallback((projectKeyOrWorkingDir: string, nextCollapsed: boolean) => {
    const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
    if (!projectKey) return;
    setStored((prev) => {
      const isCollapsed = Boolean(prev[projectKey]);
      if (isCollapsed === nextCollapsed) return prev;
      const next: Stored = { ...prev };
      if (nextCollapsed) {
        next[projectKey] = { collapsed: true, lastSeenAt: new Date().toISOString() };
      } else {
        delete next[projectKey];
      }
      writeToStorage(next);
      return next;
    });
  }, []);

  // collapseAll/expandAll 通过 activeDirsRef 读取最新 activeWorkingDirs，依赖
  // 空数组 —— 与 toggle 保持一致策略，避免在 activeWorkingDirs 引用变化时频繁
  // 重建。回调引用稳定 → 子组件 memo 不被打破。
  // why-deps-empty: activeWorkingDirs 故意走 ref 读取保证回调稳定；hooks 插件
  //   未来启用时需加 `// eslint-disable-next-line react-hooks/exhaustive-deps`。
  const collapseAll = useCallback(() => {
    setStored((prev) => {
      const now = new Date().toISOString();
      const next: Stored = { ...prev };
      for (const dir of activeDirsRef.current) {
        const projectKey = normalizeProjectKey(dir);
        if (!projectKey) continue;
        next[projectKey] = { collapsed: true, lastSeenAt: now };
      }
      writeToStorage(next);
      return next;
    });
  }, []);

  // why-deps-empty: 同 collapseAll；activeWorkingDirs 走 ref 读取
  const expandAll = useCallback(() => {
    setStored((prev) => {
      const next: Stored = { ...prev };
      for (const dir of activeDirsRef.current) {
        const projectKey = normalizeProjectKey(dir);
        if (!projectKey) continue;
        delete next[projectKey];
      }
      writeToStorage(next);
      return next;
    });
  }, []);

  const isAllCollapsed = useMemo(
    () =>
      activeWorkingDirs.length > 0 &&
      activeWorkingDirs.every((d) => {
        const projectKey = normalizeProjectKey(d);
        return projectKey ? collapsed.has(projectKey) : false;
      }),
    [activeWorkingDirs, collapsed],
  );

  return { collapsed, toggle, expand, setCollapsed, collapseAll, expandAll, isAllCollapsed };
}
