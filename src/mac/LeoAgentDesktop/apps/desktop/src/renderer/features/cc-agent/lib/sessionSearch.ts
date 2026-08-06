/**
 * sessionSearch — useSessionSearch 的核心 compute pipeline(纯函数)
 * ---------------------------------------------------------------------------
 * 把 hook 里"无副作用"的逻辑全部抽到这里,让单测可以不依赖 React/RTL/jsdom。
 * hook (useSessionSearch.ts) 只剩 useState + useMemo + useCallback 三种 glue。
 *
 * Pipeline:
 *   - INACTIVE (空 query):  直接返回入参 sessions(同引用,zero-cost)
 *   - ACTIVE (有 query):    fuzzyFilterAndRank(sessions, query) 按 score desc 排,
 *                           同时构造 sessionId → 命中字符下标 map 供 UI 高亮
 *
 * "is filtering" 判定 = trim 后非空。`'   '` 等价空 query,不触发过滤
 * (避免用户误敲空格让全列表清零)。
 */

import type { Session } from '@/lib/ccAgent.types';
import { fuzzyFilterAndRank } from './fuzzyMatch';

export interface SessionSearchView {
  /** 过滤 + 排序后的 session 列表;无 query 时为入参原引用。 */
  filtered: readonly Session[];
  /** sessionId → 命中字符下标(空 query 时为空 map)。 */
  matchMap: ReadonlyMap<string, readonly number[]>;
  /** trim 后非空 → true。 */
  isFiltering: boolean;
}

const EMPTY_MATCH_MAP: ReadonlyMap<string, readonly number[]> = new Map();

export function computeSessionSearchView(
  sessions: readonly Session[],
  query: string,
): SessionSearchView {
  const trimmed = query.trim();
  const isFiltering = trimmed.length > 0;

  if (!isFiltering) {
    return { filtered: sessions, matchMap: EMPTY_MATCH_MAP, isFiltering: false };
  }

  const ranked = fuzzyFilterAndRank(sessions, trimmed, (s) => s.title);
  const matchMap = new Map<string, readonly number[]>();
  for (let i = 0; i < ranked.length; i += 1) {
    matchMap.set(ranked[i].item.id, ranked[i].indices);
  }
  const filtered: readonly Session[] = ranked.map((r) => r.item);
  return { filtered, matchMap, isFiltering: true };
}
