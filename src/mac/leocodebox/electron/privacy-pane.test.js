import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { accessibilityPaneUrls } from './privacy-pane.js';

test('辅助功能设置指向系统隐私页', () => {
  const urls = accessibilityPaneUrls();
  assert.ok(urls.length >= 1);
  assert.ok(urls.every((url) => url.startsWith('x-apple.systempreferences:')));
  assert.ok(urls.some((url) => url.includes('Privacy_Accessibility')));
});

test('装机壳会打开辅助功能设置', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:open-accessibility/);
  assert.match(main, /openAccessibilityPrefs|accessibilityPaneUrls/);
  assert.match(preload, /openAccessibility/);
});
