/**
 * fuzzyMatch — vitest unit tests
 *
 * 覆盖:基础匹配 / 不匹配 / 空 query / 评分维度 / 排序稳定性 / 高亮 indices 正确性 /
 * 多语言脚本词边界 / 边界 case。
 */

import { describe, expect, it } from 'vitest';

import { fuzzyMatch, fuzzyFilterAndRank } from '@/features/cc-agent/lib/fuzzyMatch';

describe('fuzzyMatch — base behavior', () => {
  it('returns score 0 + empty indices for empty query', () => {
    const r = fuzzyMatch('anything', '');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.indices).toEqual([]);
  });

  it('returns null when query has no subsequence in title', () => {
    expect(fuzzyMatch('hello world', 'xyz')).toBeNull();
    expect(fuzzyMatch('abc', 'abcd')).toBeNull();
  });

  it('returns null for empty title with non-empty query', () => {
    expect(fuzzyMatch('', 'a')).toBeNull();
  });

  it('matches subsequence case-insensitively and reports indices in title', () => {
    const r = fuzzyMatch('AaaBbbCcc', 'abc');
    expect(r).not.toBeNull();
    // 贪心首次命中:A(0), B(3), C(6)
    expect(r!.indices).toEqual([0, 3, 6]);
  });

  it('produces strictly ascending indices', () => {
    const r = fuzzyMatch('refactor session header', 'rsh');
    expect(r).not.toBeNull();
    const ix = r!.indices;
    for (let i = 1; i < ix.length; i += 1) {
      expect(ix[i]).toBeGreaterThan(ix[i - 1]);
    }
  });
});

describe('fuzzyMatch — scoring', () => {
  it('prefers prefix over mid-string match (first-char ×2 + true-prefix bonus)', () => {
    const a = fuzzyMatch('abc-xyz', 'abc')!;
    const b = fuzzyMatch('xyz-abc', 'abc')!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('rewards consecutive matches over scattered word-boundary hits', () => {
    const consec = fuzzyMatch('foobar', 'foo')!;
    const scattered = fuzzyMatch('f_o_o_bar', 'foo')!;
    expect(consec.score).toBeGreaterThan(scattered.score);
  });

  it('rewards word-boundary hits (separator before)', () => {
    const boundary = fuzzyMatch('refactor-session', 'rs')!;
    const interior = fuzzyMatch('refactorsession', 'rs')!;
    expect(boundary.score).toBeGreaterThan(interior.score);
  });

  it('rewards camelCase boundary hits', () => {
    const camel = fuzzyMatch('refactorSession', 'rs')!;
    const interior = fuzzyMatch('refactorsession', 'rs')!;
    expect(camel.score).toBeGreaterThan(interior.score);
  });

  it('prefers shorter title at equal evidence', () => {
    const short = fuzzyMatch('abc', 'abc')!;
    const long = fuzzyMatch('abc' + ' '.repeat(100), 'abc')!;
    expect(short.score).toBeGreaterThan(long.score);
  });
});

describe('fuzzyFilterAndRank', () => {
  const items = [
    { id: '1', title: 'Refactor session header' },
    { id: '2', title: 'Fix chat blank middle' },
    { id: '3', title: 'Add project bar search' },
    { id: '4', title: 'session-grouping refactor' },
    { id: '5', title: 'unrelated thing' },
  ];

  it('returns full list with empty query', () => {
    const out = fuzzyFilterAndRank(items, '', (it) => it.title);
    expect(out.map((r) => r.item.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('filters out non-matching items', () => {
    const out = fuzzyFilterAndRank(items, 'session', (it) => it.title);
    const ids = out.map((r) => r.item.id);
    expect(ids).toContain('1');
    expect(ids).toContain('4');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('5');
  });

  it('ranks prefix / word-boundary matches first', () => {
    const out = fuzzyFilterAndRank(items, 'session', (it) => it.title);
    const top = out[0].item.id;
    expect(['1', '4']).toContain(top);
  });

  it('attaches indices for highlight', () => {
    const out = fuzzyFilterAndRank(items, 'fix', (it) => it.title);
    const fix = out.find((r) => r.item.id === '2');
    expect(fix).toBeDefined();
    expect(fix!.indices.length).toBe(3);
    expect(fix!.indices).toEqual([0, 1, 2]);
  });

  it('is stable for equal-score ties (preserves input order)', () => {
    const same = [
      { id: 'a', title: 'foo' },
      { id: 'b', title: 'foo' },
      { id: 'c', title: 'foo' },
    ];
    const out = fuzzyFilterAndRank(same, 'foo', (it) => it.title);
    expect(out.map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('fuzzyMatch — edge cases', () => {
  it('empty title + empty query → score 0, no indices (no crash)', () => {
    const r = fuzzyMatch('', '');
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.indices).toEqual([]);
  });

  it('exact-case match scores higher than mixed-case (EXACT_CASE bonus)', () => {
    const exact = fuzzyMatch('Refactor', 'Ref')!;
    const mixed = fuzzyMatch('Refactor', 'ref')!;
    expect(exact.score).toBeGreaterThan(mixed.score);
  });

  it('CJK title smoke test — does not crash, indices in bounds', () => {
    expect(fuzzyMatch('重构项目', 'r')).toBeNull();
    const r = fuzzyMatch('重构项目搜索', '项目');
    expect(r).not.toBeNull();
    expect(r!.indices.every((i) => i >= 0 && i < '重构项目搜索'.length)).toBe(true);
  });

  it('title ending with separator + query is the lone leading char', () => {
    const r = fuzzyMatch('foo-', 'f')!;
    expect(r.indices).toEqual([0]);
  });

  it('handles long title without regression (smoke)', () => {
    const long = 'a'.repeat(500) + 'session' + 'b'.repeat(500);
    const r = fuzzyMatch(long, 'session');
    expect(r).not.toBeNull();
    const idx = r!.indices;
    expect(idx.length).toBe(7);
    for (let i = 1; i < idx.length; i += 1) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    expect(idx[idx.length - 1]).toBeLessThan(long.length);
  });

  it('CJK / ASCII punctuation acts as word boundary', () => {
    const withSep = fuzzyMatch('重构,项目', '项')!;
    const withoutSep = fuzzyMatch('重构项目目', '项')!;
    expect(withSep.score).toBeGreaterThan(withoutSep.score);
  });
});

describe('fuzzyMatch — multi-script word boundary', () => {
  // 词边界判定基于 Unicode `\p{L}\p{N}` 反集,所有脚本的字母都被识别为
  // "词内字符",不会被错判为分隔符。这些断言锁住该不变量,防止有人改回
  // 显式字符段的 ASCII / CJK 白名单(那种实现会 regress 这些脚本)。

  it('Hangul interior char is NOT a word boundary', () => {
    const interior = fuzzyMatch('프로', '로')!;
    const trueBoundary = fuzzyMatch('a-로', '로')!;
    expect(trueBoundary.score).toBeGreaterThan(interior.score);
  });

  it('Cyrillic interior char is NOT a word boundary', () => {
    const interior = fuzzyMatch('Привет', 'р')!;
    const trueBoundary = fuzzyMatch('a-р', 'р')!;
    expect(trueBoundary.score).toBeGreaterThan(interior.score);
  });

  it('Accented Latin (Latin Extended) interior char is NOT a word boundary', () => {
    const interior = fuzzyMatch('über', 'b')!;
    const trueBoundary = fuzzyMatch('a-b', 'b')!;
    expect(trueBoundary.score).toBeGreaterThan(interior.score);
  });

  it('Greek interior char is NOT a word boundary', () => {
    const interior = fuzzyMatch('αβγ', 'β')!;
    const trueBoundary = fuzzyMatch('a-β', 'β')!;
    expect(trueBoundary.score).toBeGreaterThan(interior.score);
  });

  it('Hangul word with separator gets boundary bonus correctly', () => {
    const withSep = fuzzyMatch('프로-젝트', '젝')!;
    const withoutSep = fuzzyMatch('프로젝트', '젝')!;
    expect(withSep.score).toBeGreaterThan(withoutSep.score);
  });
});
