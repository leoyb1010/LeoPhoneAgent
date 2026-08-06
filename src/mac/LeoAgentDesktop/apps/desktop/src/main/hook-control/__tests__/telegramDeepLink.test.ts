import { describe, expect, it } from 'vitest';

import {
  parseTelegramConnectUrl,
  telegramAddToGroupUrl,
  telegramBotUrl,
  validateTelegramExternalUrl,
} from '../telegramDeepLink.js';

const TOKEN = 'A'.repeat(43);

describe('Telegram deep-link validation', () => {
  it('accepts only the canonical one-time bind shape', () => {
    expect(parseTelegramConnectUrl(`https://t.me/Cindy_TestBot?start=${TOKEN}`)).toEqual({
      url: `https://t.me/Cindy_TestBot?start=${TOKEN}`,
      botUsername: 'Cindy_TestBot',
      token: TOKEN,
    });
  });

  it.each([
    `http://t.me/CindyTestBot?start=${TOKEN}`,
    `https://telegram.me/CindyTestBot?start=${TOKEN}`,
    `https://t.me.evil.test/CindyTestBot?start=${TOKEN}`,
    `https://user@t.me/CindyTestBot?start=${TOKEN}`,
    `https://t.me:443/CindyTestBot?start=${TOKEN}`,
    `https://t.me:444/CindyTestBot?start=${TOKEN}`,
    `https://t.me/CindyTestBot?start=${TOKEN}#fragment`,
    `https://t.me/CindyTestBot?start=${TOKEN}#`,
    `https://t.me/CindyTestBot/?start=${TOKEN}`,
    `https://t.me/CindyTestBot?start=${TOKEN}&next=https://evil.test`,
    `https://t.me/CindyTestBot?start=${TOKEN}&start=${TOKEN}`,
    `https://t.me/CindyTestBot?%73tart=${TOKEN}`,
    'https://t.me/CindyTestBot?start=short',
    `https://t.me/not-a-bot?start=${TOKEN}`,
    ` https://t.me/CindyTestBot?start=${TOKEN}`,
  ])('rejects unsafe or non-canonical input: %s', (url) => {
    expect(() => parseTelegramConnectUrl(url)).toThrow();
  });

  it('builds provider URLs only from validated bot usernames', () => {
    expect(telegramBotUrl('CindyTestBot')).toBe('https://t.me/CindyTestBot');
    expect(telegramAddToGroupUrl('CindyTestBot')).toBe('https://t.me/CindyTestBot?startgroup=true');
    expect(() => telegramBotUrl('bad/nameBot')).toThrow();
  });

  it('validates open-bot and add-to-group actions without accepting arbitrary queries', () => {
    expect(validateTelegramExternalUrl('https://t.me/CindyTestBot')).toBe(
      'https://t.me/CindyTestBot',
    );
    expect(validateTelegramExternalUrl('https://t.me/CindyTestBot?startgroup=true')).toBe(
      'https://t.me/CindyTestBot?startgroup=true',
    );
    expect(() => validateTelegramExternalUrl('https://t.me/CindyTestBot#')).toThrow();
    expect(() => validateTelegramExternalUrl('https://t.me/CindyTestBot?')).toThrow();
    expect(() => validateTelegramExternalUrl('https://t.me/CindyTestBot?admin=1')).toThrow();
  });
});
