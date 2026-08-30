export type TreasuryRelatedCandidate = {
  id: string;
  title?: string | null;
  summary?: string | null;
  snippet?: string | null;
  source_uri?: string | null;
  source_label: string;
  tags: string[];
  archived: boolean;
  created_at: string | number;
};

const keywords = (...values: Array<string | null | undefined>): Set<string> => {
  const result = new Set<string>();
  for (const word of values.flatMap((value) => (value ?? '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((value) => value.length >= 2)) {
    result.add(word);
    if (word.length >= 4 && word.length <= 40) {
      for (let index = 0; index < word.length - 1; index += 1) result.add(word.slice(index, index + 2));
    }
  }
  return result;
};

const sourceKey = ({ source_uri: sourceUri, source_label: sourceLabel }: TreasuryRelatedCandidate): string | null => {
  if (sourceUri) {
    try {
      const host = new URL(sourceUri).hostname.toLocaleLowerCase();
      if (host) return `host:${host}`;
    } catch { /* fall through to the user-visible source label */ }
  }
  const label = sourceLabel.trim().toLocaleLowerCase();
  const generic = new Set([
    '', '收藏', '文本', '笔记', '文件', '图片', '网页', 'agent 保存', '聊天 artifact', 'mac 文件',
    'collection', 'text', 'note', 'file', 'image', 'web', 'agent saved', 'chat artifact', 'mac file',
  ]);
  return generic.has(label) ? null : `label:${label}`;
};

export function rankTreasuryRelated<T extends TreasuryRelatedCandidate>(target: T, items: T[], limit = 5): T[] {
  const targetTags = new Set(target.tags.map((tag) => tag.toLocaleLowerCase()));
  const targetKeywords = keywords(target.title, target.summary, target.snippet);
  const targetSource = sourceKey(target);
  return items.flatMap((candidate): Array<{ candidate: T; score: number }> => {
    if (candidate.id === target.id || candidate.archived) return [];
    const sharedTags = candidate.tags.filter((tag) => targetTags.has(tag.toLocaleLowerCase())).length;
    const sameSource = targetSource !== null && targetSource === sourceKey(candidate);
    const overlap = [...keywords(candidate.title, candidate.summary, candidate.snippet)]
      .filter((term) => targetKeywords.has(term)).length;
    const score = sharedTags * 4 + (sameSource ? 2 : 0) + Math.min(overlap, 3);
    return score > 0 ? [{ candidate, score }] : [];
  }).sort((left, right) => right.score - left.score
    || new Date(right.candidate.created_at).getTime() - new Date(left.candidate.created_at).getTime())
    .slice(0, Math.max(0, limit)).map(({ candidate }) => candidate);
}
