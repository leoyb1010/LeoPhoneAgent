import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canLockApp, lockLabel, lockToast } from './session-lock';

test('只有装机壳能锁住软件', () => {
  assert.equal(canLockApp(null), false);
  assert.equal(canLockApp({}), false);
  assert.equal(canLockApp({ setAppLock: async () => ({ on: true }) }), true);
  assert.equal(lockLabel(false), '锁住软件');
  assert.equal(lockLabel(true), '解锁');
  assert.match(lockToast(true), /已锁住/);
  assert.match(lockToast(false), /已解锁/);
});

test('2.0 壳接上了锁住软件，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canLockApp/);
  assert.match(app, /lockLabel|锁住软件/);
  assert.match(pages, /onLockApp|锁住软件/);
  assert.match(main, /leocodebox-desktop:app-lock/);
  assert.match(main, /promptTouchID|lock-screen/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /锁住软件|已锁住/);
});
