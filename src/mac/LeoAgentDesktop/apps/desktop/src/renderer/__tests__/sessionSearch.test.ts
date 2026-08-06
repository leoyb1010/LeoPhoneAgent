/**
 * sessionSearch — vitest unit tests
 *
 * 覆盖 useSessionSearch 的核心 compute pipeline(下沉到 computeSessionSearchView 纯函数后)。
 * 不依赖 RTL/jsdom —— 纯输入数据 → 输出 view 的逻辑。
 *
 * 配套覆盖关系:
 *   - fuzzyMatch 评分细节 → fuzzyMatch.test.ts
 *   - 高亮 segments 渲染 → highlightSegments.test.ts
 *   - 本文件             → 两者拼接成 search view 的 pipeline 行为
 *   - hook 副作用        → useSessionSearch.ts 表面只剩 useState glue,可视审查保证
 */

import { describe, it, expect } from 'vitest';

import { computeSessionSearchView } from '@/features/cc-agent/lib/sessionSearch';
import type { Session } from '@/lib/ccAgent.types';

/* ---------------- helpers ---------------- */

function s(partial: Partial<Session> & { id: string; title: string }): Session {
  return {
    id: partial.id,
    userId: 'u',
    title: partial.title,
    workingDir: partial.workingDir ?? null,
    workspaceKind: partial.workspaceKind ?? 'project',
    agentKind: partial.agentKind ?? 'cc',
    status: partial.status ?? 'active',
    pinnedAt: partial.pinnedAt ?? null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-01-01T00:00:00.000Z',
    userSendAt: partial.userSendAt ?? '2026-01-01T00:00:00.000Z',
    _count: partial._count ?? { messages: 1 },
  } as Session;
}

const SAMPLE: Session[] = [
  s({ id: '1', title: 'Refactor session header' }),
  s({ id: '2', title: 'Fix chat blank middle' }),
  s({ id: '3', title: 'Add project bar search' }),
  s({ id: '4', title: 'session-grouping refactor' }),
  s({ id: '5', title: 'unrelated thing' }),
];

/* ---------------- INACTIVE: empty / whitespace query ---------------- */

describe('computeSessionSearchView — INACTIVE (empty / whitespace query)', () => {
  it('empty query returns input by reference + empty matchMap + isFiltering=false', () => {
    const view = computeSessionSearchView(SAMPLE, '');
    expect(view.filtered).toBe(SAMPLE);
    expect(view.matchMap.size).toBe(0);
    expect(view.isFiltering).toBe(false);
  });

  it('whitespace-only query also treated as INACTIVE (trim semantics)', () => {
    const view = computeSessionSearchView(SAMPLE, '   ');
    expect(view.filtered).toBe(SAMPLE);
    expect(view.isFiltering).toBe(false);
  });
});

/* ---------------- ACTIVE: non-empty query ---------------- */

describe('computeSessionSearchView — ACTIVE (non-empty query)', () => {
  it('filters out non-matching items', () => {
    const view = computeSessionSearchView(SAMPLE, 'session');
    const ids = view.filtered.map((x) => x.id);
    expect(ids).toContain('1');
    expect(ids).toContain('4');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('5');
    expect(view.isFiltering).toBe(true);
  });

  it('builds matchMap with indices for every filtered item', () => {
    const view = computeSessionSearchView(SAMPLE, 'fix');
    expect(view.matchMap.has('2')).toBe(true);
    expect(view.matchMap.get('2')?.length).toBe(3);
    expect(view.matchMap.has('5')).toBe(false);
  });

  it('orders by score (prefix wins over scattered)', () => {
    const view = computeSessionSearchView(SAMPLE, 'session');
    // id=4 ("session-grouping refactor") 是真正的前缀,排第一
    expect(view.filtered[0].id).toBe('4');
  });
});

/* ---------------- edge cases ---------------- */

describe('computeSessionSearchView — edge cases', () => {
  it('empty sessions list with non-empty query → empty filtered + empty matchMap + isFiltering=true', () => {
    const view = computeSessionSearchView([], 'anything');
    expect(view.filtered).toEqual([]);
    expect(view.matchMap.size).toBe(0);
    expect(view.isFiltering).toBe(true);
  });

  it('query that matches nothing → empty filtered + isFiltering=true', () => {
    const view = computeSessionSearchView(SAMPLE, 'zzzzzzz');
    expect(view.filtered.length).toBe(0);
    expect(view.isFiltering).toBe(true);
  });

  it('empty sessions + empty query → returns input ref', () => {
    const empty: Session[] = [];
    const view = computeSessionSearchView(empty, '');
    expect(view.filtered).toBe(empty);
    expect(view.isFiltering).toBe(false);
  });
});
