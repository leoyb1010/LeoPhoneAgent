import { describe, expect, it } from 'vitest';
import {
  buildMobileMessageRenderItems,
  type MobileMessageRenderItem,
  type MobileSubagentGroupItem,
} from '@/session/messageRenderModel';
import {
  findMobileMessageSearchHits,
  nextMessageSearchIndex,
  normalizeMessageSearchIndex,
} from '@/session/messageSearch';
import type { RemoteMessage } from '@/session/types';

function message(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

function toolUse(id: string, toolName: string, input: unknown, seconds: number): RemoteMessage {
  return message({
    id,
    role: 'tool_use',
    toolUseId: id,
    content: { toolUseId: id, toolName, input },
    createdAt: at(seconds),
  });
}

describe('messageSearch', () => {
  it('finds message body and attachment path matches in rendered items', () => {
    const items = buildMobileMessageRenderItems([
      message({
        id: 'user',
        role: 'user',
        content: {
          text: 'Please inspect the release notes.',
          files: [{ name: 'roadmap.pdf', path: '/repo/docs/roadmap.pdf' }],
        },
        createdAt: at(1),
      }),
      message({ id: 'answer', role: 'assistant', content: 'The notes look consistent.', createdAt: at(2) }),
    ]);

    expect(findMobileMessageSearchHits(items, 'release notes')).toMatchObject([
      { itemKey: 'message-user', sourceKey: 'user', label: 'user' },
    ]);
    expect(findMobileMessageSearchHits(items, 'roadmap.pdf')).toMatchObject([
      { itemKey: 'message-user', sourceKey: 'user', label: 'user' },
    ]);
  });

  it('returns the parent work group key when a folded child matches', () => {
    const items = buildMobileMessageRenderItems([
      message({ id: 'user', role: 'user', content: 'run tests', createdAt: at(1) }),
      message({
        id: 'thinking',
        role: 'thinking',
        content: { text: 'checking commands', durationMs: 1200, isRedacted: false },
        createdAt: at(2),
      }),
      toolUse('bash-1', 'Bash', { command: 'pnpm test:mobile' }, 3),
      message({
        id: 'answer',
        role: 'assistant',
        content: 'Mobile test passed.',
        createdAt: at(8),
      }),
    ]);

    const hits = findMobileMessageSearchHits(items, 'test:mobile');
    expect(hits).toMatchObject([
      {
        itemKey: 'work-thinking',
        sourceKey: 'bash-1',
        label: 'Bash',
      },
    ]);
    expect(hits[0]?.preview).toContain('pnpm test:mobile');
  });

  it('searches todo and diff payload text without expanding UI components first', () => {
    const items = buildMobileMessageRenderItems([
      toolUse('todo-1', 'TodoWrite', {
        todos: [{ content: 'Verify remote screenshots', status: 'in_progress' }],
      }, 1),
      toolUse('edit-1', 'Edit', {
        file_path: '/repo/apps/mobile/app/sessions/[sessionId].tsx',
        old_string: 'placeholder',
        new_string: 'message search panel',
      }, 2),
      message({ id: 'answer', role: 'assistant', content: 'done', createdAt: at(5) }),
    ]);

    // 采用桌面共享实现后,todo 卡为顶层独立项(itemKey 即其自身 key),剩余 Edit 工具组单独成组
    // (组 key 取首个子项 tool_group 的 `work-edit-1`)。
    expect(findMobileMessageSearchHits(items, 'remote screenshots')[0]).toMatchObject({
      itemKey: 'todo-todo-1',
      sourceKey: 'todo-todo-1',
      label: 'todo',
    });
    expect(findMobileMessageSearchHits(items, 'message search panel')[0]).toMatchObject({
      itemKey: 'work-edit-1',
      sourceKey: 'edit-1',
      label: 'Edit',
    });
  });

  it('normalizes and wraps active hit indexes', () => {
    expect(normalizeMessageSearchIndex(0, 5)).toBe(-1);
    expect(normalizeMessageSearchIndex(3, -1)).toBe(0);
    expect(normalizeMessageSearchIndex(3, 7)).toBe(2);
    expect(nextMessageSearchIndex(3, -1, 'next')).toBe(0);
    expect(nextMessageSearchIndex(3, -1, 'previous')).toBe(2);
    expect(nextMessageSearchIndex(3, 2, 'next')).toBe(0);
    expect(nextMessageSearchIndex(3, 0, 'previous')).toBe(2);
  });
});

describe('messageSearch — 子 agent 卡内可见文本可被搜索(回归)', () => {
  function firstSubagentGroup(items: readonly MobileMessageRenderItem[]): MobileSubagentGroupItem {
    const group = items.find((item): item is MobileSubagentGroupItem => item.type === 'subagent_group');
    if (!group) throw new Error('expected a subagent_group in render items');
    return group;
  }

  // 顶层 user + 一个 Agent 子 agent(内层子消息 CHILDTOKEN + 终稿 SUMMARYTOKEN + 派活描述 DESCTOKEN)。
  function buildItemsWithSubagent(): MobileMessageRenderItem[] {
    return buildMobileMessageRenderItems([
      message({ id: 'user', role: 'user', content: 'TOPLEVELTOKEN', createdAt: at(1) }),
      toolUse('A1', 'Agent', { description: '调研 DESCTOKEN', subagent_type: 'Explore' }, 2),
      message({
        id: 'child',
        role: 'assistant',
        content: '子 agent 内层输出 CHILDTOKEN',
        agentMeta: { parentUuid: 'A1' },
        createdAt: at(3),
      }),
      message({ id: 'A1r', role: 'tool_result', toolUseId: 'A1', content: '子 agent 终稿 SUMMARYTOKEN', createdAt: at(4) }),
    ]);
  }

  it('命中顶层普通消息(回归:不被子 agent 改动破坏)', () => {
    const hits = findMobileMessageSearchHits(buildItemsWithSubagent(), 'TOPLEVELTOKEN');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.preview).toContain('TOPLEVELTOKEN');
  });

  it('命中子 agent 内层 childItems,itemKey 映射到父卡片', () => {
    const items = buildItemsWithSubagent();
    const group = firstSubagentGroup(items);
    const hits = findMobileMessageSearchHits(items, 'CHILDTOKEN');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemKey).toBe(group.key);
    expect(hits[0]?.preview).toContain('CHILDTOKEN');
  });

  it('命中子 agent 终稿 summary,itemKey 映射到父卡片', () => {
    const items = buildItemsWithSubagent();
    const group = firstSubagentGroup(items);
    expect(group.summary).toContain('SUMMARYTOKEN');
    const hits = findMobileMessageSearchHits(items, 'SUMMARYTOKEN');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemKey).toBe(group.key);
  });

  it('命中子 agent 卡头派活描述,itemKey 映射到父卡片', () => {
    const items = buildItemsWithSubagent();
    const group = firstSubagentGroup(items);
    const hits = findMobileMessageSearchHits(items, 'DESCTOKEN');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemKey).toBe(group.key);
  });

  it('每个 subagent_group 至多产一个 hit', () => {
    const items = buildItemsWithSubagent();
    const group = firstSubagentGroup(items);
    // “子 agent” 同时出现在 childItems 与 summary,但同一张卡只应产一个 hit(取第一处命中)。
    const hits = findMobileMessageSearchHits(items, '子 agent');
    expect(hits.filter((hit) => hit.itemKey === group.key)).toHaveLength(1);
  });

  it('无匹配返回空', () => {
    expect(findMobileMessageSearchHits(buildItemsWithSubagent(), 'NOSUCHTOKEN')).toEqual([]);
  });
});
