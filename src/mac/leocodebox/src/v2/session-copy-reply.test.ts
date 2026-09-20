import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { lastAiReply } from './session-reply';
import { canCopyLastReply, copyLastReplyToast } from './session-copy-reply';

test('只有模型说完的那句才能复制走', () => {
  const rows = [
    { k: 'user' as const, key: 'u', text: '改按钮' },
    { k: 'ai' as const, key: 'a', text: '先改登录', streaming: false },
  ];
  assert.equal(canCopyLastReply(rows), true);
  assert.equal(canCopyLastReply([]), false);
  assert.equal(lastAiReply(rows), '先改登录');
  assert.match(copyLastReplyToast(), /刚说的/);
});

test('2.0 壳接上了复制刚说的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /copyLastReply/);
  assert.match(app, /复制刚说的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /复制刚说的/);
});
