/**
 * toolSegmentSettledIds.test.ts
 * ---------------------------------------------------------------------------
 * issue #450 — tool_segment 的 settledIds 状态判定数据源。
 *
 * settledIds 与 resultMap 的区别:resultMap 只收「要展示的」结果内容,而
 * settledIds 收「结果已到达」这个事实 — 包括被 shouldHideToolResult 隐藏的
 * orca 通信空结果。行级 running/done 若只看 resultMap,这些工具会在流式中
 * 永久显示 running(计划阶段实测确认的坑)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

const mkUser = (id: string): ChatMessage => ({ clientId: id, role: 'user', content: '...' });

const mkTool = (id: string, toolName: string, toolInput: unknown = {}): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

const mkResult = (id: string, toolUseId: string, content = 'result'): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content,
  toolUseId,
});

function findToolSegment(messages: ChatMessage[]) {
  const { items } = buildRenderItems(messages);
  const segment = items.find((it) => it.type === 'tool_segment');
  if (!segment || segment.type !== 'tool_segment') throw new Error('no tool_segment built');
  return segment;
}

describe('tool_segment settledIds', () => {
  it('marks a tool with a paired result as settled (toolUseId path)', () => {
    const segment = findToolSegment([
      mkUser('u1'),
      mkTool('t1', 'Bash', { command: 'ls' }),
      mkResult('r1', 'tu-t1', 'file list'),
    ]);
    expect(segment.settledIds.has('t1')).toBe(true);
    expect(segment.resultMap.has('t1')).toBe(true);
  });

  it('leaves a pending tool (no result yet) unsettled', () => {
    const segment = findToolSegment([
      mkUser('u1'),
      mkTool('t1', 'Bash', { command: 'ls' }),
      mkResult('r1', 'tu-t1', 'done'),
      mkTool('t2', 'Read', { file_path: '/a.ts' }),
    ]);
    expect(segment.settledIds.has('t1')).toBe(true);
    expect(segment.settledIds.has('t2')).toBe(false);
    expect(segment.resultMap.has('t2')).toBe(false);
  });

  it('marks hidden orca communication results as settled without exposing them in resultMap', () => {
    // 空 orca 通信结果(ok: true、无 user-facing 字段)会被 shouldHideToolResult
    // 隐藏 — 不进 resultMap,但必须计入 settledIds。
    const segment = findToolSegment([
      mkUser('u1'),
      mkTool('t1', 'mcp__orca_worker_bridge__send_to_lead', { message: 'hi' }),
      mkResult('r1', 'tu-t1', JSON.stringify({ ok: true })),
    ]);
    expect(segment.settledIds.has('t1')).toBe(true);
    expect(segment.resultMap.has('t1')).toBe(false);
  });

  it('marks adjacency-paired results (legacy messages without toolUseId) as settled', () => {
    const legacyTool: ChatMessage = {
      clientId: 't1',
      role: 'tool_use',
      content: '',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    };
    const legacyResult: ChatMessage = {
      clientId: 'r1',
      role: 'tool_result',
      content: 'file list',
    };
    const segment = findToolSegment([mkUser('u1'), legacyTool, legacyResult]);
    expect(segment.settledIds.has('t1')).toBe(true);
    expect(segment.resultMap.has('t1')).toBe(true);
  });
});
