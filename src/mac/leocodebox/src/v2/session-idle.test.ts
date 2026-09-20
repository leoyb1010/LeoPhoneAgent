import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { idleBackToast } from './session-idle';

test('能说出走开了一会儿', () => {
  assert.match(idleBackToast(), /走开/);
});

test('2.0 壳接上了走开提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /idleBackToast/);
  assert.match(app, /onIdleBack/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /走开|idleBackToast/);
});
