import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canCommitSessionFiles, clipCommitMessage, commitSessionFilesToast, defaultCommitMessage } from './session-commit';

test('只有本机列出的改动能记下', () => {
  assert.equal(canCommitSessionFiles('local', ['src/a.ts']), true);
  assert.equal(canCommitSessionFiles('local', ['  ']), false);
  assert.equal(canCommitSessionFiles('fold', ['src/a.ts']), false);
  assert.equal(defaultCommitMessage('  改审批  '), '改审批');
  assert.equal(defaultCommitMessage(''), '记下这次改动');
  assert.equal(clipCommitMessage('a\nb'), 'a b');
  assert.equal(commitSessionFilesToast('a1b2c3d'), '已记下 a1b2c3d');
});

test('2.0 壳接上了本次改动记下', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /commitLocalFiles/);
  assert.match(app, /canCommitSessionFiles/);
  assert.match(app, />记下这次改动</);
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /file\/commit/);
  assert.match(routes, /commitSessionFiles/);
});
