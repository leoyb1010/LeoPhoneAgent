import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '@/session/messageRenderModel';
import { reconcileMobileMessageRenderItems } from '@/session/messageRenderReconcile';
import type { RemoteMessage } from '@/session/types';

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function message(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: timestamp(0),
    ...patch,
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(BASE_TIME + offsetSeconds * 1000).toISOString();
}

function createLargeDesktopMessageFixture(turns: number): RemoteMessage[] {
  const messages: RemoteMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const offset = turn * 5;
    const toolUseId = `tool-${turn}`;
    const isTodoTurn = turn % 10 === 0;
    messages.push(
      message({
        id: `user-${turn}`,
        role: 'user',
        content: { text: `Request ${turn}`, images: [], files: [] },
        createdAt: timestamp(offset),
      }),
      message({
        id: `thinking-${turn}`,
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: `Inspecting request ${turn}`,
          durationMs: 1200,
          isRedacted: false,
        },
        createdAt: timestamp(offset + 1),
      }),
      message({
        id: toolUseId,
        role: 'tool_use',
        toolUseId,
        content: isTodoTurn
          ? {
              toolUseId,
              toolName: 'TodoWrite',
              input: {
                todos: [
                  { content: `Inspect turn ${turn}`, status: 'completed' },
                  { content: `Patch turn ${turn}`, status: 'in_progress' },
                ],
              },
            }
          : {
              toolUseId,
              toolName: 'Read',
              input: { file_path: `/repo/src/file-${turn}.ts` },
            },
        createdAt: timestamp(offset + 2),
      }),
      message({
        id: `tool-result-${turn}`,
        role: 'tool_result',
        toolUseId,
        content: isTodoTurn ? 'todo updated' : `contents ${turn}`,
        createdAt: timestamp(offset + 3),
      }),
      message({
        id: `assistant-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Answer ${turn}` }],
        createdAt: timestamp(offset + 4),
      }),
    );
  }
  return messages;
}

describe('message render performance', () => {
  it('normalizes and groups a 1000-message desktop transcript without losing stable structure', () => {
    const rawMessages = createLargeDesktopMessageFixture(200);

    const start = performance.now();
    const items = buildMobileMessageRenderItems(rawMessages);
    const durationMs = performance.now() - start;

    expect(rawMessages).toHaveLength(1000);
    expect(durationMs).toBeLessThan(1500);
    // 桌面共享实现把 transcript 中的 plan/todo 卡拆成顶层独立项,较旧的「折叠进 work_group」多出 1 项。
    expect(items).toHaveLength(601);
    expect(items.slice(0, 6).map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'message',
      'message',
      'work_group',
      'message',
    ]);

    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 6)).toEqual([
      'message-user-0',
      'work-thinking-0',
      'message-assistant-0',
      'message-user-1',
      'work-thinking-1',
      'message-assistant-1',
    ]);
  });

  it('keeps historical row references stable across 250 streaming tail updates', () => {
    const messages: RemoteMessage[] = [];
    for (let turn = 0; turn < 100; turn += 1) {
      const offset = turn * 2;
      messages.push(
        message({
          id: `user-${turn}`,
          role: 'user',
          content: { text: `Request ${turn}`, images: [], files: [] },
          createdAt: timestamp(offset),
        }),
        message({
          id: `assistant-${turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: `Answer ${turn}` }],
          agentMeta: { isStreaming: turn === 99 },
          createdAt: timestamp(offset + 1),
        }),
      );
    }

    let previous: readonly MobileMessageRenderItem[] = buildMobileMessageRenderItems(
      messages,
      { isSessionStreaming: true },
    );
    for (let delta = 1; delta <= 250; delta += 1) {
      const nextMessages = messages.slice();
      nextMessages[nextMessages.length - 1] = {
        ...nextMessages[nextMessages.length - 1],
        content: [{ type: 'text', text: `Answer 99 ${delta}` }],
      };
      const next = buildMobileMessageRenderItems(nextMessages, { isSessionStreaming: true });
      const reconciled = reconcileMobileMessageRenderItems(previous, next);
      const changedRows = reconciled.reduce(
        (count, item, index) => count + (item === previous[index] ? 0 : 1),
        0,
      );
      expect(changedRows).toBe(1);
      previous = reconciled;
    }
  });
});
