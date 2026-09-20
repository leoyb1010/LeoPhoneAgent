import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { busyQuitCopy, shouldConfirmBusyQuit } from './busy-quit.js';

test('只有本机还在跑、退出会停掉服务时才先问', () => {
  assert.equal(shouldConfirmBusyQuit({ busy: true, keepServer: false }), true);
  assert.equal(shouldConfirmBusyQuit({ busy: true, keepServer: true }), false);
  assert.equal(shouldConfirmBusyQuit({ busy: false, keepServer: false }), false);
  assert.equal(shouldConfirmBusyQuit({}), false);
  const copy = busyQuitCopy();
  assert.match(copy.message, /还有会话在跑/);
  assert.match(copy.stay, /接着跑/);
  assert.match(copy.quit, /退出/);
});

test('2.0 壳没有把退出确认叠进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('../src/v2/App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('./main.js', import.meta.url)), 'utf8');
  assert.match(main, /shouldConfirmBusyQuit/);
  assert.match(main, /busyQuitCopy/);
  assert.match(main, /showMessageBox/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /还有会话在跑|接着跑/);
});
