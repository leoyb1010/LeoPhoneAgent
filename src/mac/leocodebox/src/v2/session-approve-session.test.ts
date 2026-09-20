import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canApproveForSession, sessionApproveChoice } from './session-approve-session';

test('要批准时可以先准这一会话', () => {
  assert.equal(sessionApproveChoice(['once', 'session', 'deny']), 'session');
  assert.equal(sessionApproveChoice(['once', 'always', 'deny']), 'always');
  assert.equal(sessionApproveChoice(['once', 'deny']), '');
  assert.equal(canApproveForSession({
    machine: 'local',
    status: 'waiting_for_approval',
    choices: ['once', 'always', 'deny'],
  }), true);
  assert.equal(canApproveForSession({
    machine: 'local',
    status: 'waiting_for_approval',
    choices: ['once', 'deny'],
  }), false);
  assert.equal(canApproveForSession({
    machine: 'local',
    status: 'running',
    choices: ['once', 'always', 'deny'],
  }), false);
  assert.equal(canApproveForSession({
    machine: 'phone',
    status: 'waiting_for_approval',
    choices: ['once', 'always', 'deny'],
  }), false);
});

test('2.0 先准这一会话不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canApproveForSession/);
  assert.match(app, /sessionApproveChoice/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /先准这一会话|canApproveForSession/);
});
