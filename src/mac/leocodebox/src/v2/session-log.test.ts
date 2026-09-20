import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowSessionLog, clipCommitSubject, isCommitHash, sessionLogToast } from './session-log';

test('只有本机、合法 hash 才能看提交', () => {
  assert.equal(canShowSessionLog('local'), true);
  assert.equal(canShowSessionLog('fold'), false);
  assert.equal(isCommitHash('68b40175'), true);
  assert.equal(isCommitHash('../HEAD'), false);
  assert.equal(isCommitHash(''), false);
  assert.equal(clipCommitSubject('  修  登录  '), '修 登录');
  assert.match(sessionLogToast(0), /还没有/);
  assert.match(sessionLogToast(3), /3/);
});

test('2.0 壳接上了最近提交', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /listLocalCommits/);
  assert.match(app, /showLocalCommit/);
  assert.match(app, /最近提交/);
});
