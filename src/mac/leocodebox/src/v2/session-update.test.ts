import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canCheckUpdate, checkUpdateLabel, checkUpdateToast, nextUpdateAction } from './session-update';

test('检查更新的文案跟着状态走', () => {
  assert.equal(canCheckUpdate(null), false);
  assert.equal(canCheckUpdate({}), false);
  assert.equal(canCheckUpdate({ checkForUpdates: async () => ({}) }), true);
  assert.equal(checkUpdateLabel(null), '检查更新');
  assert.equal(checkUpdateLabel({ status: 'available' }), '下载更新');
  assert.equal(checkUpdateLabel({ status: 'downloaded' }), '装上更新');
  assert.equal(checkUpdateLabel({ status: 'checking' }), '正在更新');
  assert.equal(nextUpdateAction({ status: 'available' }), 'download');
  assert.equal(nextUpdateAction({ status: 'downloaded' }), 'install');
  assert.equal(nextUpdateAction({ status: 'checking' }), 'wait');
  assert.equal(nextUpdateAction(null), 'check');
  assert.match(checkUpdateToast({ status: 'up-to-date' }), /已经是最新/);
  assert.match(checkUpdateToast({ status: 'available', latestVersion: '2.1.99' }), /2\.1\.99/);
  assert.match(checkUpdateToast({ status: 'development-build' }), /开发构建/);
});

test('2.0 壳接上了检查更新，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const pages = readFileSync(fileURLToPath(new URL('./pages.tsx', import.meta.url)), 'utf8');
  const preload = readFileSync(fileURLToPath(new URL('../../electron/preload.cjs', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canCheckUpdate/);
  assert.match(app, /checkUpdateLabel|检查更新/);
  assert.match(pages, /onCheckUpdate|检查更新/);
  assert.match(preload, /checkForUpdates/);
  assert.match(main, /leocodebox-desktop:update-check/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /检查更新|下载更新|装上更新/);
});
