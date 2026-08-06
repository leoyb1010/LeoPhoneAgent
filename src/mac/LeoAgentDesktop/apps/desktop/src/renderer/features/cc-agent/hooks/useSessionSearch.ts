/**
 * useSessionSearch — 单 Project 内 session 搜索状态 hook
 * ---------------------------------------------------------------------------
 * 作用域:per-project,每个 ProjectNode 实例自带一份独立状态。"搜索状态仅作用
 * 于该 project,不影响其他 project 的展开/折叠状态" —— 不做任何全局 / 持久化,
 * 纯本地 useState。
 *
 * 实质 compute 逻辑(过滤 + 评分排序)抽到 `lib/sessionSearch.ts` 的
 * `computeSessionSearchView` 纯函数。本 hook 只做:
 *   - 两个 useState (isOpen / query)
 *   - 一个 useMemo 包 compute
 *   - 三个 useCallback 暴露动作
 * 业务测试在 `__tests__/sessionSearch.test.ts`,本 hook 因为只剩 React glue,
 * 通过可视审查 + 类型保证正确。
 *
 * API:
 *   isOpen        是否展开 inline 输入框
 *   query         当前关键字(trim 前的原始值,直接绑定 input)
 *   open()        打开输入框
 *   close()       关闭输入框 + 清空 query
 *   setQuery(v)   更新关键字
 *   filtered      过滤 + 排序后的 session 列表(无 query 时为入参原序)
 *   matchMap      sessionId → 命中字符下标数组,供 SessionItem highlight
 *   isFiltering   有非空 query(trim 后)时为 true,用于 ProjectNode 决定是否强制展开
 *
 * 性能:useMemo 依赖 sessions 引用 + query。useProjectGroups 已 memo 化组内
 * sessions,所以重渲染时 sessions 引用稳定 → 只在 query 变化时重算。
 * computeSessionSearchView 在 200 sessions × 5 字符 query 下 < 1ms。
 */

import { useCallback, useMemo, useState } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { computeSessionSearchView } from '../lib/sessionSearch';

export interface UseSessionSearchReturn {
  isOpen: boolean;
  query: string;
  open: () => void;
  close: () => void;
  setQuery: (v: string) => void;
  /** 过滤 + 排序后的 session 列表;无 query 时为入参原引用。 */
  filtered: readonly Session[];
  /** sessionId → 命中字符下标数组(空 query 时为空 map,SessionItem 走原渲染路径)。 */
  matchMap: ReadonlyMap<string, readonly number[]>;
  /** 有非空 query 时为 true,用于 ProjectNode 强制展开 project。 */
  isFiltering: boolean;
}

export function useSessionSearch(sessions: readonly Session[]): UseSessionSearchReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');

  const view = useMemo(
    () => computeSessionSearchView(sessions, query),
    [sessions, query],
  );

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryState('');
  }, []);

  const setQuery = useCallback((v: string) => {
    setQueryState(v);
  }, []);

  return {
    isOpen,
    query,
    open,
    close,
    setQuery,
    filtered: view.filtered,
    matchMap: view.matchMap,
    isFiltering: view.isFiltering,
  };
}
