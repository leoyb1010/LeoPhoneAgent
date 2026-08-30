import { randomUUID } from 'node:crypto';

import { parseTreasuryQuery, treasuryDb, type TreasureItem } from '@/modules/database/index.js';

export type TreasurySearchResult = Pick<
  TreasureItem,
  'id' | 'title' | 'kind' | 'created_at' | 'tags'
> & {
  source: string;
  snippet: string;
  score: number;
  match_sources: string[];
};

const queryTerms = (query: string): string[] => parseTreasuryQuery(query).textQuery
  .toLowerCase().split(/\s+/).filter(Boolean);

const compactSnippet = (item: TreasureItem, query: string, maxChars = 240): string => {
  const sources = [item.title, item.summary, item.annotation, item.original_text]
    .filter((value): value is string => Boolean(value));
  const terms = queryTerms(query);
  const needle = terms[0] ?? '';
  const matching = sources.find((value) => terms.some((term) => value.toLowerCase().includes(term)))
    ?? sources[0] ?? '';
  if (matching.length <= maxChars) return matching;
  const index = Math.max(0, matching.toLowerCase().indexOf(needle));
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  return `${start ? '…' : ''}${matching.slice(start, start + maxChars)}…`;
};

const matchSources = (item: TreasureItem, query: string): string[] => {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  return [
    ['title', item.title], ['summary', item.summary], ['annotation', item.annotation],
    ['body', item.original_text], ['tags', item.tags.join(' ')],
  ].flatMap(([name, value]) => terms.some((term) => String(value ?? '').toLowerCase().includes(term))
    ? [String(name)] : []);
};

export const treasuryService = {
  search(userId: number, query: string, limit = 20): TreasurySearchResult[] {
    return treasuryDb.search(userId, query, limit).map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      source: item.source_uri ?? item.source_label,
      created_at: item.created_at,
      snippet: compactSnippet(item, query),
      tags: item.tags,
      score: item.score,
      match_sources: matchSources(item, query),
    }));
  },

  get(userId: number, ids: string[]): TreasureItem[] {
    // Metadata only in Phase 1. Large bodies/assets remain separate and are
    // added to the on-demand transport in Phase 4.
    return treasuryDb.get(userId, ids);
  },

  save(userId: number, input: Omit<TreasureItem, 'id' | 'created_at' | 'updated_at'>): TreasureItem {
    const now = new Date().toISOString();
    return treasuryDb.save(userId, { ...input, id: randomUUID(), created_at: now, updated_at: now }).item;
  },

  update(userId: number, input: TreasureItem): TreasureItem | null {
    return treasuryDb.update(userId, { ...input, updated_at: new Date().toISOString() });
  },
};
