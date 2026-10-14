/**
 * 模型选择器的搜索相关度，移植自 iOS `ModelSearchScorer.swift`。纯逻辑，不改任何选择或路由。
 *
 * 每个搜索词必须命中某个字段；命中档位：前缀 > 词边界 > 子串 > 模糊（按序出现）。
 * 整个查询恰好等于模型 ID 或显示名时直接排第一。服务商名称命中的权重低于模型本身。
 */
export interface ModelSearchFields {
  displayName: string;
  baseDisplayName: string;
  modelId: string;
  providerLabel: string;
}

export const MODEL_SEARCH_EXACT_SCORE = 100_000;
export const MODEL_SEARCH_PREFIX_SCORE = 400;
export const MODEL_SEARCH_WORD_BOUNDARY_SCORE = 300;
export const MODEL_SEARCH_SUBSTRING_SCORE = 200;
export const MODEL_SEARCH_FUZZY_SCORE = 100;
/** 服务商名称命中时扣掉的分数，保证同档位下模型字段优先。 */
export const MODEL_SEARCH_PROVIDER_PENALTY = 50;

const COMBINING_MARKS = /\p{M}/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** 大小写、变音符、全半角不敏感：NFKD 把全角拆成半角并分离附加符号，再去掉附加符号。 */
export function normalizeModelSearchText(value: string): string {
  return value.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
}

/** null = 不匹配；数值越大越相关。空查询返回 0（全部匹配）。 */
export function scoreModelSearch(query: string, fields: ModelSearchFields): number | null {
  const q = normalizeModelSearchText(query).trim();
  if (!q) return 0;
  const modelFields = [fields.modelId, fields.displayName, fields.baseDisplayName].map(
    normalizeModelSearchText,
  );
  const provider = normalizeModelSearchText(fields.providerLabel);
  let total = 0;
  for (const term of q.split(/\s+/u).filter(Boolean)) {
    let best: number | null = null;
    for (const field of modelFields) {
      const s = termScore(term, field, true);
      if (s !== null) best = best === null ? s : Math.max(best, s);
    }
    const providerScore = termScore(term, provider, false);
    if (providerScore !== null) {
      const adjusted = providerScore - MODEL_SEARCH_PROVIDER_PENALTY;
      best = best === null ? adjusted : Math.max(best, adjusted);
    }
    if (best === null) return null;
    total += best;
  }
  if (modelFields.includes(q)) total += MODEL_SEARCH_EXACT_SCORE;
  return total;
}

/** 稳定排序：分数高的在前，同分保持原顺序。不匹配的条目被丢掉。 */
export function rankModelSearch<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ModelSearchFields,
): T[] {
  const scored: Array<{ offset: number; score: number; item: T }> = [];
  items.forEach((item, offset) => {
    const score = scoreModelSearch(query, fields(item));
    if (score !== null) scored.push({ offset, score, item });
  });
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.offset - b.offset));
  return scored.map((entry) => entry.item);
}

export function termScore(term: string, field: string, allowFuzzy: boolean): number | null {
  if (!term || !field) return null;
  if (field.startsWith(term)) return MODEL_SEARCH_PREFIX_SCORE;
  let found = false;
  let from = 0;
  for (;;) {
    const index = field.indexOf(term, from);
    if (index < 0) break;
    found = true;
    // index > 0：前缀已在上面返回。取前一个完整码点判断是否落在词边界。
    const before = Array.from(field.slice(0, index)).at(-1) ?? "";
    if (!LETTER_OR_NUMBER.test(before)) return MODEL_SEARCH_WORD_BOUNDARY_SCORE;
    from = index + 1;
  }
  if (found) return MODEL_SEARCH_SUBSTRING_SCORE;
  const termChars = Array.from(term);
  if (!allowFuzzy || termChars.length < 3) return null;
  const spread = subsequenceSpread(termChars, Array.from(field));
  if (spread === null) return null;
  // 字符挨得越紧越相关；最多扣到 1 分，永远低于子串命中。
  const gaps = spread - termChars.length;
  return MODEL_SEARCH_FUZZY_SCORE - Math.min(gaps, MODEL_SEARCH_FUZZY_SCORE - 1);
}

/** 词按顺序出现时，从第一个命中字符到最后一个命中字符的跨度；不出现返回 null。 */
function subsequenceSpread(term: readonly string[], field: readonly string[]): number | null {
  let bestSpread: number | null = null;
  for (let start = 0; start < field.length; start += 1) {
    if (field[start] !== term[0]) continue;
    let ti = 1;
    let fi = start + 1;
    while (ti < term.length && fi < field.length) {
      if (field[fi] === term[ti]) ti += 1;
      fi += 1;
    }
    if (ti === term.length) {
      const spread = fi - start;
      bestSpread = bestSpread === null ? spread : Math.min(bestSpread, spread);
    }
  }
  return bestSpread;
}
