import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { sessionIsBusyToHalt } from './session-halt.js';

test('一次停掉只收正在跑或等审批的会话，idle 不动', () => {
  assert.equal(sessionIsBusyToHalt('running'), true);
  assert.equal(sessionIsBusyToHalt('waiting_for_approval'), true);
  assert.equal(sessionIsBusyToHalt('idle'), false);
  assert.equal(sessionIsBusyToHalt('cancelled'), false);
});

test('管理器接上了 haltBusy，路由挂在本机 halt', () => {
  const service = readFileSync(fileURLToPath(new URL('./harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(service, /async haltBusy\(/);
  const routes = readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/halt/);
  assert.match(routes, /haltBusyLocalSessions/);
});
