import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { canRenameSession, clipSessionTitle, renameSessionToast } from './session-title';

test('本机才能改标题，空的不算', () => {
  assert.equal(canRenameSession('local'), true);
  assert.equal(canRenameSession('fold'), false);
  assert.equal(clipSessionTitle('  修\n登录  '), '修 登录');
  assert.equal(clipSessionTitle('x'.repeat(90)).length, 80);
  assert.match(renameSessionToast('修登录'), /修登录/);
});

test('改标题事件会改掉会话名', () => {
  const view = applyEvent(emptyView(), { event: 'session.title', title: '修登录' });
  assert.equal(view.title, '修登录');
});

test('2.0 壳接上了改标题', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /renameLocalSession/);
  assert.match(app, /canRenameSession/);
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/title/);
  assert.match(routes, /setTitle/);
});
