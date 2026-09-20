import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { displayAddedToast, displayChangeToast, displayRemovedToast } from './session-display';

test('能说出屏幕插上还是拔掉', () => {
  assert.match(displayAddedToast(), /插上/);
  assert.match(displayRemovedToast(), /拔掉/);
  assert.equal(displayChangeToast('removed'), displayRemovedToast());
  assert.equal(displayChangeToast('added'), displayAddedToast());
});

test('2.0 壳接上了插拔屏幕提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /displayChangeToast/);
  assert.match(app, /onDisplayChanged/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /插上|拔掉|displayChangeToast/);
});
