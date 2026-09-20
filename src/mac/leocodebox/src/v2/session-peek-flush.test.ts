import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canFlushPeekOnSend, peekFlushedToast, peekIsDirty } from './session-peek-flush';

test('发出去会先把预览写回去', () => {
  assert.equal(peekIsDirty('old', 'new'), true);
  assert.equal(peekIsDirty('same', 'same'), false);
  assert.equal(peekIsDirty('old', null), false);
  assert.equal(canFlushPeekOnSend({
    machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: 'old', draft: 'new',
  }), true);
  assert.equal(canFlushPeekOnSend({
    machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: 'old', draft: 'old',
  }), false);
  assert.equal(canFlushPeekOnSend({
    machine: 'phone', projectId: 'p1', path: '/tmp/a.ts', peek: 'old', draft: 'new',
  }), false);
  assert.equal(canFlushPeekOnSend({
    machine: 'local', projectId: 'p1', path: '/tmp/a.ts', peek: '正在读…', draft: 'new',
  }), false);
  assert.match(peekFlushedToast('src/a.ts'), /a\.ts/);
});

test('2.0 发出去先写预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canFlushPeekOnSend/);
  assert.match(app, /writeProjectFile/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /先写下|peekFlushed|写回预览/);
});
