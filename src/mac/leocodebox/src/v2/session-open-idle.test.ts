import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenIdleSession, canSubmitNewSession, openIdleLabel, openIdleToast } from './session-open-idle';

test('能先开目录，第一句后再说', () => {
  assert.equal(canOpenIdleSession('local'), true);
  assert.equal(canOpenIdleSession('phone'), false);
  assert.equal(canSubmitNewSession('local', ''), true);
  assert.equal(canSubmitNewSession('phone', ''), false);
  assert.equal(canSubmitNewSession('phone', '改这个'), true);
  assert.equal(openIdleLabel(false), '先开着');
  assert.equal(openIdleLabel(true), '开始');
  assert.match(openIdleToast(), /随时说/);
});

test('2.0 开箱能空着开本机，不进输入栏', () => {
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(flow, /canSubmitNewSession|先开着/);
  assert.match(app, /openIdleToast/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /先开着|openIdle/);
});
