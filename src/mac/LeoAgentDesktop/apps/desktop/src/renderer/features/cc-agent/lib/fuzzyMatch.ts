/**
 * fuzzyMatch — 子序列模糊匹配 + 评分(纯函数)
 * ---------------------------------------------------------------------------
 * 用途:列表型实时模糊搜索(目前用于 Sidebar Project 内 session 标题搜索)。
 * 适用规模:每个待搜列表几百项以内。
 *
 * 算法:单遍贪心子序列扫描(非 DP)。case-insensitive 匹配 + 评分维度:
 *   - 词边界 bonus:前一字符不是字母 / 数字(空格 / 标点 / 分隔符) → +15
 *   - 驼峰边界 bonus:ASCII 小写后接大写 → +15
 *   - 连续匹配 bonus:与上一个命中字符相邻 → +20(故意大于 WORD_BOUNDARY,
 *     让连续命中胜过 scattered 词边界命中,符合"敲连续字符就期望连续"的直觉)
 *   - 首字符权重:第一个 query 字符的命中分数额外 ×2
 *   - 真前缀 bonus:第一个命中且落在 title 起首位置(index 0) → +2,
 *     用于 tiebreaker(同样命中词边界,真前缀略胜)
 *   - 精确大小写 bonus:精确同 case 命中 → +1
 *   - 短标题 bonus:title 越短分数越高(避免长 title 因为命中字符多压过短 title)
 * 返回 `{ score, indices } | null`。indices 严格升序,可直接用于 UI 切 segments 渲染。
 *
 * 设计取舍:
 *   - 借鉴 VSCode `fuzzyScore` / fzf `FuzzyMatchV2` 的 bonus 体系,简化为单遍扫描
 *     (DP 在几百项 + 短 query 场景下相比贪心的排序质量提升边际很小,代码量翻倍)
 *   - <1000 项规模无需 worker / debounce / 索引预处理
 *   - 输入空 query → 返回 score=0 + 空 indices(由调用方决定是否短路过滤)
 *
 * 已知限制:
 *   - **Surrogate pair / emoji 高亮可能错位**:用 charCodeAt 而非 codePointAt
 *     迭代;若 title 含 4-byte emoji 且命中位置落在 surrogate 中段,UI 高亮可能
 *     切成乱码。session title 几乎不出现 emoji,概率极低,代价/收益不划算。
 *   - **CJK 词边界识别有限**:纯 CJK title (无标点) 的内点不算 boundary;
 *     scattered 命中只能靠首字符 ×2 拉开差距。实际 session title 大多带空格 /
 *     英文 / 标点,这一限制影响小。
 *
 * 性能基线(粗估,principle-based):
 *   - 200 sessions × 平均 30 字符 title × 5 字符 query → fuzzy compute 单次 < 1ms
 *   - DOM 渲染负载:每次 keystroke 重渲染 ≤ 200 个 SessionItem,每个 title 内
 *     ≤ 20 个 <mark> 节点。两平台 Electron Chromium 内核一致,理论无显著差异。
 *     未在 Windows 弱集显机器上实测,如出现输入延迟需补 React.memo + 虚拟化
 */

const Bonus = {
  WORD_BOUNDARY: 15,
  CONSECUTIVE: 20,
  EXACT_CASE: 1,
  TRUE_PREFIX: 2,
} as const;

/**
 * 词边界判定:前一字符不是 Unicode 字母 / 数字(包含 ASCII / CJK / Hangul /
 * Cyrillic / Greek / Latin Extended 等所有脚本的字母),或当前位置发生 ASCII
 * 小写→大写的驼峰跳转。索引 0 视为词边界。
 *
 * `\p{L}` 覆盖任何脚本的字母,`\p{N}` 覆盖任何数字 → 反集就是"分隔符 /
 * 标点 / 空格"。这种"反白名单"判定能正确处理多语言场景,不会把非 ASCII
 * 字母错判为分隔符。
 */
const NON_LETTER_NUMBER_RE = /[^\p{L}\p{N}]/u;

function isWordBoundary(title: string, i: number): boolean {
  if (i === 0) return true;
  if (NON_LETTER_NUMBER_RE.test(title[i - 1])) return true;
  const prev = title.charCodeAt(i - 1);
  const curr = title.charCodeAt(i);
  if (prev >= 97 && prev <= 122 && curr >= 65 && curr <= 90) return true;
  return false;
}

export interface FuzzyMatchResult {
  /** 评分,数值越大越匹配。仅用于同 query 下排序,跨 query 比较无意义。 */
  score: number;
  /** 命中字符在 title 中的下标(严格升序),供 UI 高亮渲染。 */
  indices: number[];
}

/**
 * 计算 title 对 query 的模糊匹配分数。
 * - query 为空 → 返回 `{ score: 0, indices: [] }`(全部命中,不过滤)
 * - 不匹配(query 中某字符在 title 中找不到) → 返回 null
 *
 * 大小写策略:case-insensitive 子序列匹配。query 与 title 均 toLowerCase 后比对;
 * 对精确 case 命中额外加 EXACT_CASE 小 bonus,不让大小写差异左右排序。
 */
export function fuzzyMatch(title: string, query: string): FuzzyMatchResult | null {
  if (!query) return { score: 0, indices: [] };
  if (!title) return null;

  const tLower = title.toLowerCase();
  const qLower = query.toLowerCase();
  const tLen = title.length;
  const qLen = query.length;
  if (qLen > tLen) return null;

  const indices: number[] = [];
  let score = 0;
  let lastMatchIdx = -2;
  let ti = 0;

  for (let qi = 0; qi < qLen; qi += 1) {
    const qc = qLower.charCodeAt(qi);
    while (ti < tLen && tLower.charCodeAt(ti) !== qc) {
      ti += 1;
    }
    if (ti >= tLen) return null;
    indices.push(ti);

    let chScore = 1;
    const consecutive = ti === lastMatchIdx + 1;
    // 连续命中只算 CONSECUTIVE bonus,不再叠加 WORD_BOUNDARY ——
    // 否则一段全在 boundary 上的散点命中会虚高过真正连续命中。
    if (consecutive) {
      chScore += Bonus.CONSECUTIVE;
    } else if (isWordBoundary(title, ti)) {
      chScore += Bonus.WORD_BOUNDARY;
    }
    if (title.charCodeAt(ti) === query.charCodeAt(qi)) chScore += Bonus.EXACT_CASE;
    if (qi === 0) {
      chScore *= 2;
      if (ti === 0) chScore += Bonus.TRUE_PREFIX;
    }
    score += chScore;

    lastMatchIdx = ti;
    ti += 1;
  }

  // 短标题轻微优先:同分情况下,标题更短的略胜
  // (1 / (tLen + 16)) * 16 平滑,避免极短 title 拿到极端 bonus
  score += 16 / (tLen + 16);

  return { score, indices };
}

export interface FuzzyRanked<T> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * 对 items 按 fuzzyMatch 评分排序,过滤掉不匹配项。
 * 排序稳定:同分按原始顺序保持(浏览器原生 Array.sort 自 ES2019 起 stable)。
 *
 * @param items     候选数组
 * @param query     搜索关键字(空字符串 → 直接返回全量,不评分)
 * @param getText   从 item 提取用于匹配的字符串
 */
export function fuzzyFilterAndRank<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): FuzzyRanked<T>[] {
  if (!query) {
    return items.map((item) => ({ item, score: 0, indices: [] }));
  }
  const out: FuzzyRanked<T>[] = [];
  for (const item of items) {
    const r = fuzzyMatch(getText(item), query);
    if (r) out.push({ item, score: r.score, indices: r.indices });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
