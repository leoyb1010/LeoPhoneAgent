import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSendFromPeek } from './session-peek-cmd';

test('看着文件也能把这句话发出去', () => {
  const looking = {
    machine: 'local',
    drawer: 'files',
    composerFocused: false,
    prompt: '再补测试',
  };
  assert.equal(canSendFromPeek(looking), true);
  assert.equal(canSendFromPeek({ ...looking, drawer: 'diff' }), true);
  assert.equal(canSendFromPeek({ ...looking, composerFocused: true }), false);
  assert.equal(canSendFromPeek({ ...looking, prompt: '  ' }), false);
  assert.equal(canSendFromPeek({ ...looking, drawer: 'term' }), false);
  assert.equal(canSendFromPeek({ ...looking, machine: 'phone' }), false);
});

test('2.0 预览发送不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canSendFromPeek/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /看着文件|canSendFromPeek/);
});
