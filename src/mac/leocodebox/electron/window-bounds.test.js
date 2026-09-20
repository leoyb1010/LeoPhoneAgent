import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sanitizeWindowBounds, snapshotWindowBounds } from './window-bounds.js';

test('只收下还在屏幕上的窗口位置', () => {
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(
    sanitizeWindowBounds({ x: 120, y: 80, width: 1440, height: 900 }, screen),
    { x: 120, y: 80, width: 1440, height: 900 },
  );
  assert.equal(sanitizeWindowBounds({ x: -9000, y: 0, width: 1440, height: 900 }, screen), null);
  assert.equal(sanitizeWindowBounds({ x: 0, y: 0, width: 800, height: 600 }, screen), null);
  assert.equal(sanitizeWindowBounds(null, screen), null);
  assert.deepEqual(
    snapshotWindowBounds({
      isMaximized: () => true,
      getNormalBounds: () => ({ x: 40, y: 30, width: 1440, height: 900 }),
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    }),
    { x: 40, y: 30, width: 1440, height: 900, maximized: true },
  );
});

test('装机壳会记下并恢复窗口位置', () => {
  const dw = readFileSync(new URL('./desktopWindow.js', import.meta.url), 'utf8');
  assert.match(dw, /WINDOW_BOUNDS_FILE|window-bounds/);
  assert.match(dw, /sanitizeWindowBounds/);
  assert.match(dw, /persistWindowBounds|readSavedWindowBounds/);
});
