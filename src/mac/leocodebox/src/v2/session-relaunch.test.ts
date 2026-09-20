import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRelaunch, relaunchBusy, relaunchBusyToast, relaunchLabel, relaunchToast } from './session-relaunch';

test('只有装机壳能重新打开，跑着的会拦住', () => {
  assert.equal(canRelaunch(null), false);
  assert.equal(canRelaunch({}), false);
  assert.equal(canRelaunch({ relaunch: async () => ({ ok: true }) }), true);
  assert.equal(relaunchLabel(), '重新打开');
  assert.match(relaunchToast(), /正在重新打开/);
  assert.match(relaunchBusyToast(), /还有会话在跑/);
  assert.equal(relaunchBusy([{ machine: 'local', s: { status: 'running' } }]), true);
  assert.equal(relaunchBusy([]), false);
});

test('2.0 壳接上了重新打开，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canRelaunch/);
  assert.match(app, /relaunchLabel|重新打开/);
  assert.match(main, /leocodebox-desktop:relaunch/);
  assert.match(main, /app\.relaunch/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /重新打开|正在重新打开/);
});
