import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { dockMenuLabels } from './dock-menu.js';

test('程序坞菜单是新会话和显示窗口，不是托盘', () => {
  assert.deepEqual(dockMenuLabels(), ['新会话', '显示窗口']);
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /app\.dock\.setMenu/);
  assert.match(main, /leocodebox-desktop:dock-new/);
  assert.doesNotMatch(main, /new Tray\(/);
  assert.doesNotMatch(main, /createTray/);
});
