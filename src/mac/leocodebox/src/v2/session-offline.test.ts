import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isBrowserOffline, offlineBanner, offlineToast, onlineToast } from './session-offline';

test('能认出断网，在线不当断', () => {
  assert.equal(isBrowserOffline({ onLine: false }), true);
  assert.equal(isBrowserOffline({ onLine: true }), false);
  assert.equal(isBrowserOffline({}), false);
  assert.equal(isBrowserOffline(null), false);
  assert.match(offlineToast(), /断网/);
  assert.match(onlineToast(), /回来/);
  assert.match(offlineBanner(), /断网/);
});

test('2.0 壳接上了断网提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /isBrowserOffline/);
  assert.match(app, /offlineToast/);
  assert.match(app, /offlineBanner/);
  assert.match(app, /addEventListener\('offline'/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /断网|offlineToast|offlineBanner/);
});
