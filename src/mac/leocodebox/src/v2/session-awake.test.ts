import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { shouldKeepAwake } from './session-awake';

test('只有本机正在跑或等审批才挡住休眠', () => {
  assert.equal(shouldKeepAwake([{ machine: 'local', s: { status: 'running' } }]), true);
  assert.equal(shouldKeepAwake([{ machine: 'local', s: { status: 'starting' } }]), true);
  assert.equal(shouldKeepAwake([{ machine: 'local', s: { status: 'waiting_for_approval' } }]), true);
  assert.equal(shouldKeepAwake([{ machine: 'local', s: { status: 'idle' } }]), false);
  assert.equal(shouldKeepAwake([{ machine: 'fold', s: { status: 'running' } }]), false);
  assert.equal(shouldKeepAwake([]), false);
});

test('2.0 壳接上了跑着不睡，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /shouldKeepAwake/);
  assert.match(app, /setSessionKeepAwake/);
  assert.match(main, /leocodebox-desktop:keep-awake/);
  assert.match(main, /powerSaveBlocker/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /不睡|keepAwake|keep-awake/);
});
