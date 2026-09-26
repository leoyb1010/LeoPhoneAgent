// ============================================================
// [leo] 插在上游 findEditMatch 里 exact 之后的两级窄匹配
// ============================================================
// 1. hashline_prefix_stripped：模型把 Read 的 `12#VK:` 前缀抄进了 old_string（每个非空行都带
//    合法前缀才剥），剥完做精确匹配；new_string 同样按整体剥离（见 normalizeLeoReplacement）。
// 2. unicode_normalized：NFC / 行尾空白 / 智能引号 / 破折号 / 特殊空格归一后匹配（text-normalize.ts）。
// 两级都比上游 line_trimmed / indentation_flexible / block_anchor 严格，所以排在它们前面。

import { stripHashlinePrefixes } from "./hashline.js";
import {
  collectUnicodeNormalizedCandidates,
  LEO_UNICODE_NORMALIZED_STRATEGY,
  type NormalizedCandidate,
} from "./text-normalize.js";

export const LEO_HASHLINE_PREFIX_STRATEGY = "hashline_prefix_stripped";

export type LeoEarlyMatchStrategy =
  | typeof LEO_HASHLINE_PREFIX_STRATEGY
  | typeof LEO_UNICODE_NORMALIZED_STRATEGY;

export function findLeoEarlyCandidates(
  content: string,
  search: string,
): { strategy: LeoEarlyMatchStrategy; candidates: NormalizedCandidate[] } | undefined {
  const stripped = stripHashlinePrefixes(search);
  if (stripped !== null && stripped !== search && stripped.trim() !== "") {
    const candidates = collectExact(content, stripped);
    if (candidates.length > 0) return { strategy: LEO_HASHLINE_PREFIX_STRATEGY, candidates };
  }
  const normalized = collectUnicodeNormalizedCandidates(content, search);
  if (normalized.length > 0) {
    return { strategy: LEO_UNICODE_NORMALIZED_STRATEGY, candidates: normalized };
  }
  return undefined;
}

/** 命中 hashline_prefix_stripped 时 new_string 也按整体剥前缀；其余策略返回 undefined 交回上游。 */
export function normalizeLeoReplacement(strategy: string, newString: string): string | undefined {
  if (strategy !== LEO_HASHLINE_PREFIX_STRATEGY) return undefined;
  return stripHashlinePrefixes(newString) ?? newString;
}

function collectExact(content: string, search: string): NormalizedCandidate[] {
  const candidates: NormalizedCandidate[] = [];
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(search, position);
    if (index === -1) break;
    candidates.push({ value: search, index });
    position = index + Math.max(search.length, 1);
  }
  return candidates;
}
