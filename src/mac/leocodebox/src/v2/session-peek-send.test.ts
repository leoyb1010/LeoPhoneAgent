import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMentionPeekOnSend, mentionPeekOnSend, promptHasPeekPath } from './session-peek-send';

test('发出去会带上正在看的文件', () => {
  const looking = {
    machine: 'local',
    drawer: 'files',
    file: 'src/v2/App2.tsx',
    cwd: '/tmp/box',
    prompt: '这里的类型错了',
  };
  assert.equal(canMentionPeekOnSend(looking), true);
  assert.equal(mentionPeekOnSend(looking), '这里的类型错了\nsrc/v2/App2.tsx');
  assert.equal(canMentionPeekOnSend({ ...looking, prompt: '先看 App2.tsx' }), false);
  assert.equal(canMentionPeekOnSend({ ...looking, prompt: '  ' }), false);
  assert.equal(canMentionPeekOnSend({ ...looking, drawer: null }), false);
  assert.equal(canMentionPeekOnSend({ ...looking, machine: 'phone' }), false);
  assert.equal(canMentionPeekOnSend({ ...looking, file: '/tmp/box/src/v2/App2.tsx' }), true);
  assert.equal(mentionPeekOnSend({ ...looking, file: '/tmp/box/src/v2/App2.tsx' }), '这里的类型错了\nsrc/v2/App2.tsx');
  assert.equal(promptHasPeekPath('改 src/v2/App2.tsx', 'src/v2/App2.tsx'), true);
});

test('2.0 带上预览文件不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mentionPeekOnSend/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /正在看的文件|mentionPeekOnSend/);
});
