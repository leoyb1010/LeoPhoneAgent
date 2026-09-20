import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_ZOOM, sanitizeZoomFactor, snapshotZoomFactor } from './window-zoom.js';

test('只收下还能看的缩放', () => {
  assert.equal(sanitizeZoomFactor(1), 1);
  assert.equal(sanitizeZoomFactor({ factor: 1.25 }), 1.25);
  assert.equal(sanitizeZoomFactor(0.4), null);
  assert.equal(sanitizeZoomFactor(3.2), null);
  assert.equal(sanitizeZoomFactor('nope'), null);
  assert.equal(snapshotZoomFactor({ getZoomFactor: () => 1.5 }), 1.5);
  assert.equal(DEFAULT_ZOOM, 1);
});

test('装机壳会记下并恢复缩放', () => {
  const dw = readFileSync(new URL('./desktopWindow.js', import.meta.url), 'utf8');
  const host = readFileSync(new URL('./viewHost.js', import.meta.url), 'utf8');
  assert.match(dw, /WINDOW_ZOOM_FILE|window-zoom/);
  assert.match(dw, /persistWindowZoom|readSavedZoomFactor/);
  assert.match(host, /applyZoom|attachZoom/);
});
