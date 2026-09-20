import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRevertSessionFile, revertSessionFileToast } from './session-revert';

test('只有本机当前文件能还原', () => {
  assert.equal(canRevertSessionFile('local', 'src/a.ts'), true);
  assert.equal(canRevertSessionFile('local', '  '), false);
  assert.equal(canRevertSessionFile('fold', 'src/a.ts'), false);
  assert.equal(revertSessionFileToast('restored'), '已还原到改之前');
  assert.equal(revertSessionFileToast('removed'), '已删掉这次新建的文件');
});

test('2.0 壳接上了本次改动还原', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /revertLocalFile/);
  assert.match(app, /canRevertSessionFile/);
  assert.match(app, />还原</);
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /file\/revert/);
  assert.match(routes, /revertSessionFile/);
});
