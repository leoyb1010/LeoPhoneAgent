import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canPullSessionRepo, pullSessionToast } from './session-pull';

test('只有本机才能把远端拉回来', () => {
  assert.equal(canPullSessionRepo('local'), true);
  assert.equal(canPullSessionRepo('fold'), false);
  assert.match(pullSessionToast('origin', 'main', true), /origin\/main/);
  assert.match(pullSessionToast('origin', 'main', false), /已经是最新/);
});

test('2.0 壳接上了拉回远端，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /pullLocalRepo/);
  assert.match(app, /拉回远端/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /拉回远端/);
});
