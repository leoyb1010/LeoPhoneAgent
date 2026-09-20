import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canPackSessionChanges, packFileName, packSessionToast } from './session-pack';

test('只有本机才能把改动打成一份', () => {
  assert.equal(canPackSessionChanges('local'), true);
  assert.equal(canPackSessionChanges('fold'), false);
  assert.equal(packFileName('修 登录'), 'leo-改动-修-登录.zip');
  assert.equal(packFileName(''), 'leo-改动.zip');
  assert.match(packSessionToast('leo-改动.zip', 2), /2/);
});

test('2.0 壳接上了带走这次改动，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /packLocalChanges/);
  assert.match(app, /带走这次改动/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,600}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /带走这次改动/);
});
