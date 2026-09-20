import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canCopyTalk, copyTalkToast } from './session-copy-talk';

test('本机才复制这次对话，空的和远端不要', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '只写一个文件 ART31.txt', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '先写 ART31.txt，别改别的。', streaming: false },
  ];
  assert.equal(canCopyTalk('local', rows), true);
  assert.equal(canCopyTalk('fold', rows), false);
  assert.equal(canCopyTalk('local', []), false);
  assert.equal(canCopyTalk('local', [{ k: 'sys' as const, key: '3', text: '提示', tone: 'muted' }]), false);
  assert.match(copyTalkToast(), /已复制这次对话/);
});

test('2.0 壳接上了复制这次对话，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canCopyTalk/);
  assert.match(app, /复制这次对话/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /复制这次对话/);
});
