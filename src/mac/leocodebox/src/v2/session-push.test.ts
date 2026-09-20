import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canPushSessionRepo, pushSessionToast } from './session-push';

test('只有本机才能把提交推到远端', () => {
  assert.equal(canPushSessionRepo('local'), true);
  assert.equal(canPushSessionRepo('fold'), false);
  assert.match(pushSessionToast('origin', 'main'), /origin\/main/);
});

test('2.0 壳接上了推到远端，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /pushLocalRepo/);
  assert.match(app, /推到远端/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /推到远端/);
});
