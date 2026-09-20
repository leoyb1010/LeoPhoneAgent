import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { memoryLowToast, memoryOkToast, memorySendToast } from './session-memory';

test('能说出内存紧不紧', () => {
  assert.match(memoryLowToast(), /内存/);
  assert.match(memoryOkToast(), /回来/);
  assert.match(memorySendToast(), /内存紧/);
});

test('2.0 壳接上了内存提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /memoryLowToast/);
  assert.match(app, /onMemoryChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /内存|memoryLowToast/);
});
