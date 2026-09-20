import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canInitSessionRepo, initSessionToast } from './session-init';

test('只有本机才能把目录做成仓库', () => {
  assert.equal(canInitSessionRepo('local'), true);
  assert.equal(canInitSessionRepo('fold'), false);
  assert.equal(initSessionToast(true, 'main'), '已做成仓库 · main');
  assert.equal(initSessionToast(true, ''), '已做成仓库');
  assert.equal(initSessionToast(false, 'main'), '已经是仓库');
});

test('2.0 壳接上了做成仓库，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /initLocalRepo/);
  assert.match(app, /做成仓库/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /做成仓库/);
});
