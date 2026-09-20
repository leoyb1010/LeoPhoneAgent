import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { EXTRA_WINDOW_OFFSET, extraWindowBounds } from './extra-window.js';

test('再开的窗口错开一点，免得盖住原来的', () => {
  const next = extraWindowBounds({ x: 100, y: 80, width: 1440, height: 960 });
  assert.equal(next.x, 100 + EXTRA_WINDOW_OFFSET);
  assert.equal(next.y, 80 + EXTRA_WINDOW_OFFSET);
  assert.equal(next.width, 1440);
  assert.ok(next.height >= 720);
  const fallback = extraWindowBounds(null);
  assert.ok(fallback.width >= 1024);
});

test('装机壳挂上了再开一个窗口，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const dw = readFileSync(new URL('./desktopWindow.js', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:extra-window/);
  assert.match(dw, /openExtraWindow/);
  assert.match(dw, /requestQuit/);
  assert.doesNotMatch(dw, /new Tray\(/);
  assert.doesNotMatch(main, /new Tray\(/);
});
