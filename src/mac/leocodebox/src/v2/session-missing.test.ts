import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isMissingSessionCwd, missingCwdToast } from './session-missing';

test('能认出目录没了，没本机能力不瞎报', async () => {
  assert.equal(await isMissingSessionCwd('/gone', { cwdExists: async () => ({ exists: false }) }), true);
  assert.equal(await isMissingSessionCwd('/here', { cwdExists: async () => ({ exists: true }) }), false);
  assert.equal(await isMissingSessionCwd('/gone', {}), false);
  assert.equal(await isMissingSessionCwd(''), false);
  assert.match(missingCwdToast(), /不在了/);
});

test('2.0 壳接上了目录没了提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /isMissingSessionCwd/);
  assert.match(app, /missingCwdToast/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /不在了|missingCwdToast/);
});
