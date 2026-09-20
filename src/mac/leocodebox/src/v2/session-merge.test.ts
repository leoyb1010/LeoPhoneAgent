import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMergeSessionBranch, mergeSessionToast } from './session-merge';

test('只有本机才能把分支并过来', () => {
  assert.equal(canMergeSessionBranch('local'), true);
  assert.equal(canMergeSessionBranch('fold'), false);
  assert.equal(mergeSessionToast('feat/登录', 'main', false), '已把 feat/登录 并到 main');
  assert.equal(mergeSessionToast('feat/登录', 'main', true), '已经并过 feat/登录');
});

test('2.0 壳接上了并到现在这条，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mergeLocalBranch/);
  assert.match(app, /并到现在这条/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /并到现在这条/);
});
