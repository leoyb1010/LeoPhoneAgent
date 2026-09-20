import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRunSessionSlash, parseComposerSlash } from './session-slash';

test('输入栏 / 能马上执行', () => {
  assert.equal(parseComposerSlash('/review'), '/review');
  assert.equal(parseComposerSlash('  /skill:brave-search 查一下  '), '/skill:brave-search 查一下');
  assert.equal(parseComposerSlash('/fix-tests --all'), '/fix-tests --all');
  assert.equal(parseComposerSlash('/'), null);
  assert.equal(parseComposerSlash('// comment'), null);
  assert.equal(parseComposerSlash('请 /review'), null);
  const ready = { machine: 'local', status: 'running', command: '/review' };
  assert.equal(canRunSessionSlash(ready), true);
  assert.equal(canRunSessionSlash({ ...ready, status: 'starting' }), true);
  assert.equal(canRunSessionSlash({ ...ready, status: 'idle' }), false);
  assert.equal(canRunSessionSlash({ ...ready, status: 'waiting_for_approval' }), false);
  assert.equal(canRunSessionSlash({ ...ready, machine: 'phone' }), false);
  assert.equal(canRunSessionSlash({ ...ready, command: '' }), false);
});

test('2.0 斜杠命令不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(app, /parseComposerSlash/);
  assert.match(app, /canRunSessionSlash/);
  assert.match(app, /type: 'prompt'/);
  assert.match(routes, /'prompt'/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /马上执行|parseComposerSlash|canRunSessionSlash/);
});
