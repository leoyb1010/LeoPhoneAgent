import { describe, expect, it } from 'vitest';

import {
  decodeCustomId,
  decodeMessageId,
  encodeCustomId,
  encodeMessageId,
} from '../codec.js';

describe('discord messageId codec', () => {
  it('round-trips channelId|messageId', () => {
    const encoded = encodeMessageId('123456789012345678', '987654321098765432');

    expect(encoded).toBe('123456789012345678|987654321098765432');
    expect(decodeMessageId(encoded)).toEqual({
      channelId: '123456789012345678',
      messageId: '987654321098765432',
    });
  });

  it('rejects malformed input', () => {
    expect(() => encodeMessageId('bad|channel', 'message')).toThrow();
    expect(() => encodeMessageId('channel', 'bad|message')).toThrow();
    expect(() => decodeMessageId('missing-separator')).toThrow();
    expect(() => decodeMessageId('|message-only')).toThrow();
    expect(() => decodeMessageId('channel-only|')).toThrow();
    expect(() => decodeMessageId('bad|extra|parts')).toThrow();
  });
});

describe('discord custom_id codec', () => {
  it('round-trips short payload inline', () => {
    const customId = encodeCustomId('permission:allow:once', {
      requestId: 'r1',
      remember: false,
    });

    expect(customId.startsWith('ref:')).toBe(false);
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(decodeCustomId(customId)).toEqual({
      buttonId: 'permission:allow:once',
      payload: { requestId: 'r1', remember: false },
    });
  });

  it('uses ref storage for payloads over 100 chars and decodes them', () => {
    const payload = { requestId: 'r1', preview: 'x'.repeat(160) };
    const customId = encodeCustomId('permission:allow:once', payload);

    expect(customId).toMatch(/^ref:/);
    expect(customId.length).toBeLessThanOrEqual(100);
    expect(decodeCustomId(customId)).toEqual({
      buttonId: 'permission:allow:once',
      payload,
    });
  });

  it('returns null for forged refs', () => {
    expect(decodeCustomId('ref:not-real')).toBeNull();
  });

  it('evicts the oldest ref after 256 entries', () => {
    const first = encodeCustomId('button:first', { preview: 'x'.repeat(160) });

    for (let i = 0; i < 256; i += 1) {
      encodeCustomId(`button:${i}`, { preview: `${i}-${'x'.repeat(160)}` });
    }

    expect(decodeCustomId(first)).toBeNull();
  });
});
