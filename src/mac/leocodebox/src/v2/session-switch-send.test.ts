import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRetryAfterModelSwitch, retryAfterModelSwitchToast } from './session-switch-send';

test('换了模型会把上一句发出去', () => {
  assert.equal(canRetryAfterModelSwitch({
    machine: 'local', wasBlocked: true, prevModel: 'openai-codex/spark', nextModel: 'openai-codex/gpt-5.5', prompt: '再改一处',
  }), true);
  assert.equal(canRetryAfterModelSwitch({
    machine: 'local', wasBlocked: false, prevModel: 'openai-codex/spark', nextModel: 'openai-codex/gpt-5.5', prompt: '再改一处',
  }), false);
  assert.equal(canRetryAfterModelSwitch({
    machine: 'local', wasBlocked: true, prevModel: 'openai-codex/spark', nextModel: 'openai-codex/spark', prompt: '再改一处',
  }), false);
  assert.equal(canRetryAfterModelSwitch({
    machine: 'phone', wasBlocked: true, prevModel: 'a', nextModel: 'b', prompt: '再改一处',
  }), false);
  assert.equal(canRetryAfterModelSwitch({
    machine: 'local', wasBlocked: true, prevModel: 'a', nextModel: 'b', prompt: '  ',
  }), false);
  assert.match(retryAfterModelSwitchToast(), /发出去/);
});

test('2.0 换模型重发不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canRetryAfterModelSwitch/);
  assert.match(app, /api\.send/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /换了模型|retryAfterModelSwitch/);
});
