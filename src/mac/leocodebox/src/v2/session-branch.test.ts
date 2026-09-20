import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSwitchSessionBranch, sanitizeBranchName, switchSessionBranchToast } from './session-branch';

test('本机才能开分支，名字会洗干净', () => {
  assert.equal(canSwitchSessionBranch('local'), true);
  assert.equal(canSwitchSessionBranch('fold'), false);
  assert.equal(sanitizeBranchName('feat/登录'), 'feat/登录');
  assert.equal(sanitizeBranchName('../HEAD'), 'leo-分支');
  assert.equal(sanitizeBranchName('  --bad name  '), 'bad-name');
  assert.equal(sanitizeBranchName(''), 'leo-分支');
  assert.match(switchSessionBranchToast('feat/登录', true), /已开到 feat\/登录/);
  assert.match(switchSessionBranchToast('main', false), /已切到 main/);
});

test('2.0 壳接上了开这条分支，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /switchLocalBranch/);
  assert.match(app, /开这条分支/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /开这条分支/);
});
