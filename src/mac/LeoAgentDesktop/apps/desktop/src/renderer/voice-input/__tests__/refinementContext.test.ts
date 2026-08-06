import { describe, expect, it } from 'vitest';

import {
  buildReplyToMessageFromChatMessages,
  buildVoiceInputHistoryContext,
} from '../refinementContext';

describe('buildReplyToMessageFromChatMessages', () => {
  it('uses the latest completed assistant reply as the message being replied to', () => {
    const replyToMessage = buildReplyToMessageFromChatMessages([
      { role: 'assistant', content: '旧回复。' },
      { role: 'user', content: '继续。' },
      { role: 'assistant', content: '正在生成到一半', isStreaming: true },
      { role: 'assistant', content: '这是最新完成的 AI 回复。'.repeat(80) },
    ]);

    expect(replyToMessage).toBeDefined();
    expect(replyToMessage).toContain('这是最新完成的 AI 回复。');
    expect(replyToMessage?.length).toBeLessThanOrEqual(500);
  });
});

describe('buildVoiceInputHistoryContext', () => {
  it('builds one bounded voice-input history block oldest to newest', () => {
    const context = buildVoiceInputHistoryContext([
      { text: '最新一次语音输入' },
      { text: '中间一次语音输入' },
      { text: '最早一次语音输入' },
    ]);

    expect(context).toEqual({
      voiceInputHistory: [
        '语音输入历史（旧到新，仅作术语、别名和用词风格参考）：',
        '- 最早一次语音输入',
        '- 中间一次语音输入',
        '- 最新一次语音输入',
      ].join('\n'),
    });
  });

  it('does not slide-truncate the voice-input history block below compaction threshold', () => {
    const context = buildVoiceInputHistoryContext(
      Array.from({ length: 30 }, (_, index) => ({
        text: `第 ${index + 1} 条语音输入 ${'内容'.repeat(160)}`,
      })),
    );

    expect(context.voiceInputHistory).toContain('第 1 条语音输入');
    expect(context.voiceInputHistory).toContain('第 30 条语音输入');
    expect((context.voiceInputHistory?.length ?? 0)).toBeGreaterThan(8_000);
  });

  it('does not include normal chat messages in the voice-input history block', () => {
    const context = buildVoiceInputHistoryContext([]);

    expect(context).toEqual({});
  });
});
