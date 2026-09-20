import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canUseDockMenu, dockNewToast } from './session-dock';

test('只有装机壳能从程序坞开新会话', () => {
  assert.equal(canUseDockMenu(null), false);
  assert.equal(canUseDockMenu({}), false);
  assert.equal(canUseDockMenu({ onDockNew: () => () => undefined }), true);
  assert.match(dockNewToast(), /程序坞/);
});

test('2.0 壳接上了程序坞新会话，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /onDockNew/);
  assert.match(app, /beginLocalNew/);
  assert.match(app, /dockNewToast/);
  assert.match(main, /app\.dock\.setMenu/);
  assert.match(main, /leocodebox-desktop:dock-new/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /程序坞|已从程序坞/);
});
