import { describe, expect, it } from 'vitest';
import {
  buildMessageRenderItems,
  type MessageRenderNormalizedMessage,
  type MessageRenderSourceMessageLike,
} from '../messageRender';
import {
  findMessageSearchHits,
  nextMessageSearchIndex,
  normalizeMessageSearchIndex,
  type MessageSearchMessageLike,
} from '../messageSearch';

type TestSource = MessageRenderSourceMessageLike & {
  clientId: string;
  content: unknown;
  createdAt: string;
  id: string;
};

type TestMessage = MessageRenderNormalizedMessage<TestSource> & MessageSearchMessageLike;

function source(id: string, content: unknown, seconds: number): TestSource {
  return {
    clientId: id,
    content,
    createdAt: at(seconds),
    id,
  };
}

function message(
  patch: Partial<TestMessage> & Pick<TestMessage, 'kind' | 'source'>,
): TestMessage {
  return {
    key: patch.source.clientId,
    label: patch.kind,
    body: '',
    createdAt: patch.source.createdAt,
    ...patch,
  };
}

function at(seconds: number): string {
  return `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
}

describe('messageSearch', () => {
  it('finds message body and attachment path matches in rendered items', () => {
    const items = buildMessageRenderItems([
      message({
        kind: 'user',
        source: source('user', 'release notes', 1),
        label: 'user',
        body: 'Please inspect the release notes.',
        attachments: [{ name: 'roadmap.pdf', path: '/repo/docs/roadmap.pdf' }],
      }),
      message({
        kind: 'assistant',
        source: source('answer', 'consistent', 2),
        label: 'assistant',
        body: 'The notes look consistent.',
      }),
    ]);

    expect(findMessageSearchHits(items, 'release notes')).toMatchObject([
      { itemKey: 'message-user', sourceKey: 'user', label: 'user' },
    ]);
    expect(findMessageSearchHits(items, 'roadmap.pdf')).toMatchObject([
      { itemKey: 'message-user', sourceKey: 'user', label: 'user' },
    ]);
  });

  it('returns the parent work group key when a folded child matches', () => {
    const items = buildMessageRenderItems([
      message({
        kind: 'user',
        source: source('user', 'run tests', 1),
        label: 'user',
        body: 'run tests',
      }),
      message({
        kind: 'thinking',
        source: source('thinking', { durationMs: 1200, isRedacted: false }, 2),
        label: 'thinking',
        body: 'checking commands',
      }),
      message({
        kind: 'tool',
        source: source('bash-1', { toolName: 'Bash', input: { command: 'pnpm test:mobile' } }, 3),
        label: 'Bash',
        body: 'Bash(pnpm test:mobile)',
      }),
      message({
        kind: 'assistant',
        source: source('answer', 'passed', 8),
        label: 'assistant',
        body: 'Mobile test passed.',
      }),
    ]);

    const hits = findMessageSearchHits(items, 'test:mobile');
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
    const items = buildMessageRenderItems([
      message({
        kind: 'tool',
        source: source('todo-1', {
          toolName: 'TodoWrite',
          input: {
            todos: [{ content: 'Verify remote screenshots', status: 'in_progress' }],
          },
        }, 1),
        label: 'TodoWrite',
        body: 'TodoWrite()',
      }),
      message({
        kind: 'tool',
        source: source('edit-1', {
          toolName: 'Edit',
          input: { file_path: '/repo/apps/mobile/app/sessions/[sessionId].tsx' },
        }, 2),
        label: 'Edit',
        body: 'Edit(/repo/apps/mobile/app/sessions/[sessionId].tsx)',
        diff: {
          filePath: '/repo/apps/mobile/app/sessions/[sessionId].tsx',
          segments: [{
            oldString: 'placeholder',
            newString: 'message search panel',
          }],
        },
      }),
      message({
        kind: 'assistant',
        source: source('answer', 'done', 5),
        label: 'assistant',
        body: 'done',
      }),
    ]);

    // 采用桌面共享实现后,todo 卡作为顶层独立项(itemKey 即其自身 key),不再被折叠进 work_group;
    // 剩余的 Edit 工具组单独成组,组 key 取首个子项(tool_group)的 `work-edit-1`。
    expect(findMessageSearchHits(items, 'remote screenshots')[0]).toMatchObject({
      itemKey: 'todo-todo-1',
      sourceKey: 'todo-todo-1',
      label: 'todo',
    });
    expect(findMessageSearchHits(items, 'message search panel')[0]).toMatchObject({
      itemKey: 'work-edit-1',
      sourceKey: 'edit-1',
      label: 'Edit',
    });
  });

  it('indexes a sub-agent task by tool input and persisted result when no live update exists', () => {
    // 重连后无 live agent_task_update:卡片标题/详情来自工具输入(description/prompt)、
    // 结果摘要来自 secondaryBody。会话内搜索必须能命中这些卡片可见内容(否则用户搜不到子任务)。
    const items = buildMessageRenderItems<TestMessage>([
      message({
        kind: 'tool',
        source: source('task-1', {
          toolName: 'Task',
          input: { description: 'Audit mobile parity', prompt: 'check reconnect path' },
        }, 1),
        label: 'Task',
        body: 'Task(...)',
        secondaryBody: 'Audited 3 files, all consistent',
      }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['work_group']);
    expect(findMessageSearchHits(items, 'Audit mobile parity')).toHaveLength(1);
    expect(findMessageSearchHits(items, 'check reconnect path')).toHaveLength(1);
    expect(findMessageSearchHits(items, 'all consistent')).toHaveLength(1);
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
