import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { autoCompactToast, looksLikeContextOverflow, shouldAutoCompact } from './session-autocompact';

test('只有本机刚失败且是上下文太长才自动压缩', () => {
  assert.equal(looksLikeContextOverflow('maximum context window exceeded'), true);
  assert.equal(looksLikeContextOverflow('上下文太长了 —— 用「压缩这条会话」后再继续'), true);
  assert.equal(looksLikeContextOverflow('rate limit 429'), false);
  assert.equal(shouldAutoCompact({
    primed: true, machine: 'local', prevStatus: 'running', nextStatus: 'failed',
    errorText: 'maximum context window exceeded',
  }), true);
  assert.equal(shouldAutoCompact({
    primed: false, machine: 'local', prevStatus: 'running', nextStatus: 'failed',
    errorText: 'maximum context window exceeded',
  }), false);
  assert.equal(shouldAutoCompact({
    primed: true, machine: 'fold', prevStatus: 'running', nextStatus: 'failed',
    errorText: 'maximum context window exceeded',
  }), false);
  assert.equal(shouldAutoCompact({
    primed: true, machine: 'local', prevStatus: 'failed', nextStatus: 'failed',
    errorText: 'maximum context window exceeded',
  }), false);
  assert.equal(shouldAutoCompact({
    primed: true, machine: 'local', prevStatus: 'running', nextStatus: 'failed',
    errorText: 'No API key found',
  }), false);
  assert.match(autoCompactToast(), /已压缩/);
});

test('2.0 壳接上了自动压缩，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /shouldAutoCompact/);
  assert.match(app, /autoCompactToast/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /已压缩|自动压缩/);
});
