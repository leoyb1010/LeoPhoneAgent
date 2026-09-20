import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionToolFailed } from './session-tool-fail';

test('命令没过会标红', () => {
  assert.equal(sessionToolFailed({ tool: 'bash', result: { details: { exitCode: 1 } } }), true);
  assert.equal(sessionToolFailed({ tool: 'bash', result: { exitCode: 0 } }), false);
  assert.equal(sessionToolFailed({ tool: 'bash', isError: true, result: { exitCode: 0 } }), true);
  assert.equal(sessionToolFailed({ tool: 'read', result: { details: { exitCode: 1 } } }), false);
  assert.equal(sessionToolFailed({ tool: 'bash', result: {} }), false);
});

test('2.0 退出码不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /sessionToolFailed/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /标红|sessionToolFailed|exitCode/);
});
