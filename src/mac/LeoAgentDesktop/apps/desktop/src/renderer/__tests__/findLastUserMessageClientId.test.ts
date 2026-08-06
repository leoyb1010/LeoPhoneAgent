/**
 * findLastUserMessageClientId.test.ts
 * ---------------------------------------------------------------------------
 * edit-last-message: 编辑入口的定位逻辑。只有全量列表里最后一条 user 消息
 * 显示编辑按钮;这里断言倒序查找对空列表 / 无 user 消息 / 尾部为 assistant
 * 或工具消息等形态都取到正确的 clientId。
 * (与 buildRenderItemsKeyStability.test.ts 同款模式:直接 import
 * MessageStream 导出的纯 helper。)
 */

import { describe, expect, it } from 'vitest';
import { findLastUserMessageClientId } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const mk = (clientId: string, role: ChatMessage['role']): ChatMessage =>
  ({ clientId, role, content: clientId, isStreaming: false }) as ChatMessage;

describe('findLastUserMessageClientId', () => {
  it('空列表 → null', () => {
    expect(findLastUserMessageClientId([])).toBeNull();
  });

  it('没有 user 消息 → null', () => {
    expect(
      findLastUserMessageClientId([mk('a1', 'assistant'), mk('t1', 'thinking')]),
    ).toBeNull();
  });

  it('典型对话:取最后一条 user,而不是第一条', () => {
    const messages = [
      mk('u1', 'user'),
      mk('a1', 'assistant'),
      mk('u2', 'user'),
      mk('a2', 'assistant'),
    ];
    expect(findLastUserMessageClientId(messages)).toBe('u2');
  });

  it('尾部跟着 assistant / tool / thinking 消息时仍定位到 user', () => {
    const messages = [
      mk('u1', 'user'),
      mk('a1', 'assistant'),
      mk('u2', 'user'),
      mk('t1', 'tool_use'),
      mk('r1', 'tool_result'),
      mk('th1', 'thinking'),
      mk('a2', 'assistant'),
    ];
    expect(findLastUserMessageClientId(messages)).toBe('u2');
  });

  it('user 是最后一条(steer / 刚发送还没回复)→ 取它自己', () => {
    const messages = [mk('u1', 'user'), mk('a1', 'assistant'), mk('u2', 'user')];
    expect(findLastUserMessageClientId(messages)).toBe('u2');
  });

  it('尾部是 isSyntheticTrigger 合成行 → 跳过,取真实最后一条 user(review P2)', () => {
    // 续跑/图片按钮的隐藏指令行渲染 null:它成为"最后一条 user"会让真实最后
    // 一条 user 消息丢失编辑入口。
    const synthetic = { ...mk('syn1', 'user'), isSyntheticTrigger: true };
    const messages = [mk('u1', 'user'), mk('a1', 'assistant'), synthetic];
    expect(findLastUserMessageClientId(messages)).toBe('u1');
  });

  it('全是合成行 → null', () => {
    const messages = [{ ...mk('syn1', 'user'), isSyntheticTrigger: true }];
    expect(findLastUserMessageClientId(messages)).toBeNull();
  });
});
