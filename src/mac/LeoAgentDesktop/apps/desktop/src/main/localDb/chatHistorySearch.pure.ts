/**
 * chatHistorySearch.pure.ts —— chatHistorySearch 引擎里"零 IO、零 electron 依赖"的
 * 纯逻辑(RRF 融合 + FTS query 构造), 抽出来便于单测。
 *
 * 与 renderer/features/cc-agent/lib/sessionSearch.ts 同思路: 把无副作用的计算从
 * 带 sqlite / embedding / electron 依赖的主引擎里剥离, 让单测不必 mock 整个环境。
 * 主引擎 chatHistorySearch.ts import 这里的函数。
 */

/** RRF 平滑常数(业界惯用 60); 越大越削弱头部排名优势。 */
export const RRF_K = 60;

export interface FusedEntry {
  messageId: string;
  score: number;
  /** 1-based FTS 排名; 未被 FTS 召回则 null。 */
  ftsRank: number | null;
  /** 1-based 向量排名; 未被向量召回则 null。 */
  vectorRank: number | null;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_arm 1 / (k + rank_arm(d)), rank 为 1-based。
 * 两路命中同一 doc 时分数相加(共识加权)。同分按 messageId 字典序兜底, 保证确定性
 * (可测、分页稳定)。
 *
 * @param ftsRanked FTS arm 命中的 messageId, 按相关度降序(best first)
 * @param vecRanked 向量 arm 命中的 messageId, 按距离升序(best first)
 */
export function fuseRRF(
  ftsRanked: readonly string[],
  vecRanked: readonly string[],
  k: number = RRF_K,
): FusedEntry[] {
  const map = new Map<string, FusedEntry>();
  const accum = (id: string, rank0: number, arm: 'fts' | 'vec') => {
    let e = map.get(id);
    if (!e) {
      e = { messageId: id, score: 0, ftsRank: null, vectorRank: null };
      map.set(id, e);
    }
    e.score += 1 / (k + rank0 + 1);
    if (arm === 'fts') e.ftsRank = rank0 + 1;
    else e.vectorRank = rank0 + 1;
  };
  ftsRanked.forEach((id, i) => accum(id, i, 'fts'));
  vecRanked.forEach((id, i) => accum(id, i, 'vec'));
  return [...map.values()].sort(
    (a, b) => b.score - a.score || a.messageId.localeCompare(b.messageId),
  );
}

/**
 * 把自然语言 query 转成 FTS5 MATCH 表达式: 抽取字母/数字/CJK 连续 run 作为 token,
 * 每个 token 用双引号包裹(中和 FTS 操作符 - * : ( ) " 等防注入/语法错), OR 连接
 * 最大化词法召回(相关度交给 bm25 + RRF 裁决)。无有效 token → null(跳过 FTS arm)。
 *
 * 注: messages_fts 用 porter unicode61 分词, CJK 连续串会被当作整体 token,
 * 故 CJK 的细粒度词法匹配有限——这正是向量 arm 补位的场景。
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const uniq = [...new Set(tokens)].slice(0, 32);
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
