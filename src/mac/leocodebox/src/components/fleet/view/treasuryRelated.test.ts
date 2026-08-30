import assert from 'node:assert/strict';
import test from 'node:test';

import { rankTreasuryRelated, type TreasuryRelatedCandidate } from './treasuryRelated';

const item = (id: string, source: string, tags: string[] = [], archived = false): TreasuryRelatedCandidate => ({
  id, title: id, summary: null, snippet: '普通内容', source_label: source, tags, archived, created_at: 1,
});

test('related Treasury ranking prefers shared tags then source and excludes archived items', () => {
  const target = item('target', '研发周报', ['缓存', '架构']);
  const ranked = rankTreasuryRelated(target, [
    target,
    item('same-source', '研发周报'),
    item('archived', '研发周报', ['缓存', '架构'], true),
    item('shared-tags', '其他', ['缓存', '架构']),
  ]);
  assert.deepEqual(ranked.map(({ id }) => id), ['shared-tags', 'same-source']);
});

test('related Treasury ranking ignores generic capture source labels', () => {
  const target: TreasuryRelatedCandidate = { ...item('target', '文本'), title: '苹果香蕉', snippet: null };
  const unrelated: TreasuryRelatedCandidate = {
    ...item('unrelated', '文本'), title: '完全不同', snippet: '没有重叠',
  };
  assert.deepEqual(rankTreasuryRelated(target, [unrelated]), []);
});
