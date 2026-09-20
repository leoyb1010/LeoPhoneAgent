import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSetOpenAtLogin, openAtLoginLabel, openAtLoginToast } from './session-login';

test('只有装机壳能设开机就开', () => {
  assert.equal(canSetOpenAtLogin(null), false);
  assert.equal(canSetOpenAtLogin({}), false);
  assert.equal(canSetOpenAtLogin({ setOpenAtLogin: async () => ({ on: true }) }), true);
  assert.match(openAtLoginToast(true), /开机就开/);
  assert.match(openAtLoginToast(false), /关掉/);
  assert.equal(openAtLoginLabel(false), '开机就开');
  assert.equal(openAtLoginLabel(true), '开机不要开');
});

test('2.0 壳接上了开机就开，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canSetOpenAtLogin/);
  assert.match(app, /开机就开/);
  assert.match(main, /leocodebox-desktop:open-at-login/);
  assert.match(main, /setLoginItemSettings/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /开机就开|开机不要开/);
});
