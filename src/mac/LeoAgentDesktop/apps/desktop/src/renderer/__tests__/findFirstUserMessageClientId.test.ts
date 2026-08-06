/**
 * findFirstUserMessageClientId.test.ts
 * ---------------------------------------------------------------------------
 * Fork/Rewind 按钮"首条 user 消息"判定的分页回归。
 *
 * 症状:会话首屏只加载尾部 50 条,一个长 turn(大量工具/思考行)把更早的
 * user 消息挤出切片后,切片里唯一的 user 消息(恰好是最后一条)被误判为
 * "整段对话的首条"→ Fork/Rewind 按钮被按首条规则隐藏,hover 只剩复制 +
 * 时间戳;往上滚动加载老页后才恢复。修正:hasMoreOlderMessages=true 时
 * 不把任何已加载消息判为首条(会话第一行必是 user 消息,它在未加载的老页里)。
 */

import { describe, expect, it } from 'vitest';
import { findFirstUserMessageClientId } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const mk = (clientId: string, role: ChatMessage['role']): ChatMessage =>
  ({ clientId, role, content: clientId, isStreaming: false }) as ChatMessage;

describe('findFirstUserMessageClientId', () => {
  it('全量已加载(无更早分页)→ 取切片首条 user', () => {
    const messages = [mk('u1', 'user'), mk('a1', 'assistant'), mk('u2', 'user')];
    expect(findFirstUserMessageClientId(messages, false)).toBe('u1');
  });

  it('还有老页未加载 → 返回 null,不把切片首条误判为对话首条(回归场景)', () => {
    // 长 turn 把更早的 user 消息挤出初始 50 条切片,切片里唯一的 user
    // (也是最后一条)曾被误判为"首条"→ Fork/Rewind 全部消失只剩复制。
    const messages = [mk('t1', 'tool_use'), mk('a1', 'assistant'), mk('u9', 'user')];
    expect(findFirstUserMessageClientId(messages, true)).toBeNull();
  });

  it('全量已加载且首条前只有非 user 行 → 仍取第一条 user', () => {
    const messages = [mk('a0', 'assistant'), mk('u1', 'user'), mk('a1', 'assistant')];
    expect(findFirstUserMessageClientId(messages, false)).toBe('u1');
  });

  it('空列表 / 无 user 消息 → null', () => {
    expect(findFirstUserMessageClientId([], false)).toBeNull();
    expect(findFirstUserMessageClientId([mk('a1', 'assistant')], false)).toBeNull();
  });
});
