import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canShowEmojiPanel, showEmojiPanel } from './emoji-panel.js';

test('只有 Mac 能弹出表情', () => {
  let n = 0;
  const appLike = { showEmojiPanel: () => { n += 1; } };
  assert.equal(canShowEmojiPanel(appLike, 'darwin'), true);
  assert.equal(canShowEmojiPanel({}, 'darwin'), false);
  assert.equal(canShowEmojiPanel(appLike, 'linux'), false);
  assert.deepEqual(showEmojiPanel(appLike, 'darwin'), { ok: true });
  assert.equal(n, 1);
  assert.throws(() => showEmojiPanel(appLike, 'linux'), /弹不出表情/);
});

test('装机壳挂上了弹出表情，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const dw = readFileSync(new URL('./desktopWindow.js', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:emoji-panel/);
  assert.match(main, /showEmojiPanel/);
  assert.match(dw, /表情/);
  assert.doesNotMatch(main, /new Tray\(/);
});
