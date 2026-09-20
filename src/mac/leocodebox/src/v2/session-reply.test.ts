import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMentionLastReply, clipLastReply, lastAiReply, mentionLastReply, mentionLastReplyToast } from './session-reply';

test('只带上已经说完的上一句，正在流的不算', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '修登录' },
    { k: 'ai' as const, key: '2', text: '先改按钮', streaming: false },
    { k: 'ai' as const, key: '3', text: '还在写', streaming: true },
  ];
  assert.equal(lastAiReply(rows), '先改按钮');
  assert.equal(canMentionLastReply(rows), true);
  assert.equal(canMentionLastReply([]), false);
  assert.equal(mentionLastReply('按这个', '先改按钮'), '按这个\n先改按钮');
  assert.equal(mentionLastReply('先改按钮', '先改按钮'), '先改按钮');
  assert.ok(clipLastReply('x'.repeat(9000)).includes('后面还有'));
  assert.match(mentionLastReplyToast(), /上一句/);
});

test('2.0 壳接上了带上上一句', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mentionLastReply/);
  assert.match(app, /canMentionLastReply/);
  assert.match(app, /带上上一句/);
});
