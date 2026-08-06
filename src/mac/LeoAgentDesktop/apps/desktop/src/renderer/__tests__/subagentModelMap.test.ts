/**
 * subagentModelMap.test.ts
 * ---------------------------------------------------------------------------
 * 锁住 buildSubagentModelMap:从子消息(带 parentToolUseId + model)反查出
 * 「父 Agent 工具调用 toolUseId → 子代理模型」映射,供 AgentTaskCard 渲染
 * subagent-model-chip(历史重载兜底来源)。纯函数,node env。
 */

import { describe, it, expect } from 'vitest';

import { buildSubagentModelMap } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const mkToolUse = (
  clientId: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  clientId,
  role: 'tool_use',
  content: '',
  toolName: 'Bash',
  ...extra,
});

describe('buildSubagentModelMap', () => {
  it('maps a subagent child to its parent Agent toolUseId → model', () => {
    const msgs: ChatMessage[] = [
      mkToolUse('agent-call', { toolName: 'Agent', toolUseId: 'toolu_AGENT' }),
      mkToolUse('child-1', {
        toolUseId: 'toolu_child1',
        parentToolUseId: 'toolu_AGENT',
        model: 'claude-haiku-4-5-20251001',
      }),
    ];
    const map = buildSubagentModelMap(msgs);
    expect(map.get('toolu_AGENT')).toBe('claude-haiku-4-5-20251001');
    expect(map.size).toBe(1);
  });

  it('picks up text-only subagent assistant children (history-reload coverage)', () => {
    // 纯文本子代理(不调工具)的子消息是 assistant,模型只在其 agentMeta;历史
    // mapServerMessages 已把 model/parentToolUseId 投影上来,map 须照样命中。
    const msgs: ChatMessage[] = [
      {
        clientId: 'asst-child',
        role: 'assistant',
        content: 'done',
        parentToolUseId: 'toolu_AGENT',
        model: 'claude-haiku-4-5-20251001',
      },
    ];
    expect(buildSubagentModelMap(msgs).get('toolu_AGENT')).toBe('claude-haiku-4-5-20251001');
  });

  it('ignores main-thread messages (no parentToolUseId)', () => {
    const msgs: ChatMessage[] = [
      mkToolUse('a', { toolUseId: 'toolu_a', model: 'claude-opus-4-8' }),
      { clientId: 'asst', role: 'assistant', content: 'hi', model: 'claude-opus-4-8' },
    ];
    expect(buildSubagentModelMap(msgs).size).toBe(0);
  });

  it('first-writer-wins for multiple children of the same Agent call', () => {
    const msgs: ChatMessage[] = [
      mkToolUse('c1', { parentToolUseId: 'toolu_AGENT', model: 'claude-haiku-4-5-20251001' }),
      mkToolUse('c2', { parentToolUseId: 'toolu_AGENT', model: 'claude-haiku-4-5-IGNORED' }),
    ];
    expect(buildSubagentModelMap(msgs).get('toolu_AGENT')).toBe('claude-haiku-4-5-20251001');
  });

  it('keeps distinct entries for concurrent Agent calls', () => {
    const msgs: ChatMessage[] = [
      mkToolUse('c1', { parentToolUseId: 'toolu_A', model: 'claude-haiku-4-5-20251001' }),
      mkToolUse('c2', { parentToolUseId: 'toolu_B', model: 'claude-sonnet-4-6' }),
    ];
    const map = buildSubagentModelMap(msgs);
    expect(map.get('toolu_A')).toBe('claude-haiku-4-5-20251001');
    expect(map.get('toolu_B')).toBe('claude-sonnet-4-6');
  });

  it('skips children missing model', () => {
    const msgs: ChatMessage[] = [
      mkToolUse('c1', { parentToolUseId: 'toolu_AGENT' }),
    ];
    expect(buildSubagentModelMap(msgs).size).toBe(0);
  });
});
