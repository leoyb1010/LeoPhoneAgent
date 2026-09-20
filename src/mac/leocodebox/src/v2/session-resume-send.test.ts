import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canResumeThenSend, resumeThenSendLabel, resumeThenSendToast } from './session-resume-send';

test('能接着把这句话发出去', () => {
  assert.equal(canResumeThenSend({ machine: 'local', canResume: true, prompt: '再改一处' }), true);
  assert.equal(canResumeThenSend({ machine: 'local', canResume: true, prompt: '  ' }), false);
  assert.equal(canResumeThenSend({ machine: 'local', canResume: false, prompt: '再改一处' }), false);
  assert.equal(canResumeThenSend({ machine: 'phone', canResume: true, prompt: '再改一处' }), false);
  assert.match(resumeThenSendLabel(), /发出去/);
  assert.match(resumeThenSendToast(), /发出去/);
});

test('2.0 续上后第一句走 prompt，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const harness = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(app, /canResumeThenSend|接着发出去/);
  assert.match(app, /continueLocal/);
  assert.match(harness, /continueWith[\s\S]*?promptTurns = 0/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /接着发出去|resumeThenSend/);
});
