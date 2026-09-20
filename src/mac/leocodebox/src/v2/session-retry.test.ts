import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRetryLastUser, lastUserPrompt, retryLastUserToast } from './session-retry';

test('只拿上一句正经提问，插话和排队不算', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '先改登录', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '改完了', streaming: false },
    { k: 'user' as const, key: '3', text: '先停一下', mode: 'steer' as const },
    { k: 'user' as const, key: '4', text: '接着再说', mode: 'follow_up' as const },
  ];
  assert.equal(lastUserPrompt(rows), '先改登录');
  assert.equal(canRetryLastUser({ canDrive: true, running: false, rows }), true);
  assert.equal(canRetryLastUser({ canDrive: true, running: true, rows }), false);
  assert.equal(canRetryLastUser({ canDrive: false, running: false, rows }), false);
  assert.equal(lastUserPrompt([]), '');
  assert.match(retryLastUserToast(), /再发上一句/);
});

test('2.0 壳接上了再发上一句', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /retryLast/);
  assert.match(app, /再发上一句/);
});
