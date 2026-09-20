import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { netpathChangeToast } from './session-netpath';

test('能说出换了网络', () => {
  assert.match(netpathChangeToast(), /换了网络/);
});

test('2.0 壳接上了换网提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /netpathChangeToast/);
  assert.match(app, /onNetpathChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /换了网络|netpathChangeToast/);
});
