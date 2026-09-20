import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { lastUserPrompt } from './session-retry';
import { canEditLastPrompt, editLastPromptDraft, editLastPromptToast } from './session-edit-prompt';

test('上一句正经提问可以放回输入栏改', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '先改登录', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '改完了', streaming: false },
    { k: 'user' as const, key: '3', text: '先停一下', mode: 'steer' as const },
  ];
  assert.equal(canEditLastPrompt(rows), true);
  assert.equal(canEditLastPrompt([]), false);
  assert.equal(lastUserPrompt(rows), '先改登录');
  assert.equal(editLastPromptDraft('别的', '先改登录'), '先改登录');
  assert.match(editLastPromptToast(), /改完再发/);
});

test('2.0 壳接上了改上一句，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /editLastPrompt/);
  assert.match(app, /改上一句/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /改上一句/);
});
