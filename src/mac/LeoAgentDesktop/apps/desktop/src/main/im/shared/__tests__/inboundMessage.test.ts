import { describe, expect, it } from 'vitest';

import type { IMAttachment } from '@cindy/im';

import { buildImUserMessage } from '../inboundMessage';

describe('attached IM delivery context', () => {
  it('uses a history-safe delivery rule without a persistent channel destination', () => {
    const message = buildImUserMessage('测试discord', [], true);

    expect(message).toEqual({
      type: 'user',
      content: expect.stringContaining('<cindy_delivery_context>'),
    });
    expect(message.content).toEqual(expect.stringContaining('automatically delivers'));
    expect(message.content).toEqual(expect.stringContaining('bot, webhook, or outbound integration'));
    expect(message.content).toEqual(expect.stringContaining('transport-independent'));
    expect(message.content).not.toEqual(expect.stringMatching(/Discord|Feishu|Slack|source=/));
    expect(message.content).toEqual(expect.stringContaining('\n\n测试discord'));
  });

  it('keeps the delivery context ahead of attachment content blocks', () => {
    const attachment: IMAttachment = {
      kind: 'image',
      absPath: 'C:\\tmp\\image.png',
      originalName: 'image.png',
      mimeType: 'image/png',
    };

    expect(buildImUserMessage('', [attachment], true)).toEqual({
      type: 'user',
      content: [
        {
          type: 'text',
          text: expect.stringContaining('<cindy_delivery_context>'),
        },
        {
          type: 'image',
          path: attachment.absPath,
          mimeType: attachment.mimeType,
        },
      ],
    });
  });

  it('keeps non-takeover IM messages byte-for-byte unchanged', () => {
    expect(buildImUserMessage('普通飞书消息', [])).toEqual({
      type: 'user',
      content: '普通飞书消息',
    });
  });
});
