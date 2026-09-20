import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMoveToApplications, moveToApplicationsBusy, moveToApplicationsBusyToast, moveToApplicationsLabel, moveToApplicationsToast } from './session-apps';

test('只有装机壳能把软件挪进程序文件夹', () => {
  assert.equal(canMoveToApplications(null), false);
  assert.equal(canMoveToApplications({}), false);
  assert.equal(canMoveToApplications({ moveToApplications: async () => ({ already: true }) }), true);
  assert.equal(moveToApplicationsLabel(false), '挪进程序文件夹');
  assert.equal(moveToApplicationsLabel(true), '已经在程序文件夹');
  assert.match(moveToApplicationsToast(false), /正在挪进程序文件夹/);
  assert.match(moveToApplicationsToast(true), /已经在程序文件夹了/);
  assert.match(moveToApplicationsBusyToast(), /还有会话在跑/);
  assert.equal(moveToApplicationsBusy([{ machine: 'local', s: { status: 'running' } }]), true);
  assert.equal(moveToApplicationsBusy([]), false);
});

test('2.0 壳接上了挪进程序文件夹，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /moveToApplicationsLabel|挪进程序文件夹/);
  assert.match(app, /moveDesktopToApplications|appsHere/);
  assert.match(main, /leocodebox-desktop:app-folder/);
  assert.match(main, /moveToApplicationsFolder/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /挪进程序文件夹|已经在程序文件夹/);
});
