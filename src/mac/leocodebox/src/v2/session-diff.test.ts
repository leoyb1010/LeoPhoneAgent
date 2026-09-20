import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowSessionDiff, sessionDiffHint } from './session-diff';

test('只有本机当前文件能看这次改动', () => {
  assert.equal(canShowSessionDiff('local', 'src/a.ts'), true);
  assert.equal(canShowSessionDiff('local', '  '), false);
  assert.equal(canShowSessionDiff('fold', 'src/a.ts'), false);
  assert.equal(sessionDiffHint('added'), '新建');
  assert.equal(sessionDiffHint('modified'), '改动');
});

test('2.0 壳接上了本次改动补丁', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /diffLocalFile/);
  assert.match(app, /canShowSessionDiff/);
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /file\/diff/);
  assert.match(routes, /diffSessionFile/);
});
