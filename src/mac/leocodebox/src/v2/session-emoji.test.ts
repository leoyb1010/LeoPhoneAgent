import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowEmoji, emojiLabel, emojiToast } from './session-emoji';

test('只有装机壳能弹出表情', () => {
  assert.equal(canShowEmoji(null), false);
  assert.equal(canShowEmoji({}), false);
  assert.equal(canShowEmoji({ showEmojiPanel: async () => ({ ok: true }) }), true);
  assert.equal(emojiLabel(), '弹出表情');
  assert.match(emojiToast(), /已弹出表情/);
});

test('2.0 壳接上了弹出表情，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /emojiLabel|弹出表情/);
  assert.match(app, /openDesktopEmoji|emojiHere/);
  assert.match(main, /leocodebox-desktop:emoji-panel/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /弹出表情|已弹出表情/);
});
