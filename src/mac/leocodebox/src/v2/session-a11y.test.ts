import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenAccessibility, openAccessibilityLabel, openAccessibilityToast } from './session-a11y';

test('只有装机壳能打开辅助功能设置', () => {
  assert.equal(canOpenAccessibility(null), false);
  assert.equal(canOpenAccessibility({}), false);
  assert.equal(canOpenAccessibility({ openAccessibility: async () => ({ ok: true }) }), true);
  assert.equal(openAccessibilityLabel(), '去开辅助功能');
  assert.match(openAccessibilityToast(), /已打开辅助功能设置/);
});

test('2.0 壳接上了去开辅助功能，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canOpenAccessibility/);
  assert.match(app, /openAccessibilityLabel|去开辅助功能/);
  assert.match(main, /leocodebox-desktop:open-accessibility/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /去开辅助功能|已打开辅助功能设置/);
});
