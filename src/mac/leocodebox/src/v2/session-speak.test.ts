import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSpeakLastReply, clipSpeakText, speakLastReplyToast } from './session-speak';

test('本机才读刚说的，空的和远端不要', () => {
  const rows = [{ k: 'ai' as const, key: '1', text: '先写 ART31.txt，别改别的。', streaming: false }];
  assert.equal(canSpeakLastReply('local', rows), true);
  assert.equal(canSpeakLastReply('fold', rows), false);
  assert.equal(canSpeakLastReply('local', []), false);
  assert.equal(canSpeakLastReply('local', [{ k: 'ai' as const, key: '2', text: '   ', streaming: false }]), false);
  assert.equal(clipSpeakText('看 `ART31.txt`\n\n好了。'), '看 ART31.txt 好了。');
  assert.equal(clipSpeakText('a'.repeat(2000)).endsWith('后面还有'), true);
  assert.match(speakLastReplyToast(), /正在读/);
});

test('2.0 壳接上了读出刚说的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canSpeakLastReply/);
  assert.match(app, /读出刚说的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /读出刚说的/);
});
