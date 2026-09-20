import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { alwaysOnTopLabel, alwaysOnTopToast, canSetAlwaysOnTop } from './session-float';

test('只有装机壳能钉在最上面', () => {
  assert.equal(canSetAlwaysOnTop(null), false);
  assert.equal(canSetAlwaysOnTop({}), false);
  assert.equal(canSetAlwaysOnTop({ setAlwaysOnTop: async () => ({ on: true }) }), true);
  assert.match(alwaysOnTopToast(true), /钉在最上面/);
  assert.match(alwaysOnTopToast(false), /取消置顶/);
  assert.equal(alwaysOnTopLabel(false), '钉在最上面');
  assert.equal(alwaysOnTopLabel(true), '不要钉在最上面');
});

test('2.0 壳接上了置顶，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canSetAlwaysOnTop/);
  assert.match(app, /alwaysOnTopLabel|钉不了窗口/);
  assert.match(main, /leocodebox-desktop:always-on-top/);
  assert.match(main, /setAlwaysOnTop/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /钉在最上面|不要钉在最上面/);
});
