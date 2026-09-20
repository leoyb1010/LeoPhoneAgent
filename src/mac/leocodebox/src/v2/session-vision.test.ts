import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canAttachSessionImages, imagePathsInPrompt, mimeForSessionImage } from './session-vision';

test('发出去会带上图片', () => {
  assert.equal(mimeForSessionImage('leo-paste-20260921-070000.png'), 'image/png');
  assert.equal(imagePathsInPrompt('看下 leo-paste-20260921-070000.png')[0], 'leo-paste-20260921-070000.png');
  assert.equal(imagePathsInPrompt('看下 `/tmp/shot.jpg`')[0], '/tmp/shot.jpg');
  assert.deepEqual(imagePathsInPrompt('https://example.com/a.png'), []);
  assert.equal(canAttachSessionImages({ machine: 'local', prompt: 'notes/a.png' }), true);
  assert.equal(canAttachSessionImages({ machine: 'phone', prompt: 'notes/a.png' }), false);
  assert.equal(canAttachSessionImages({ machine: 'local', prompt: '没有图' }), false);
});

test('2.0 带图片不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const session = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(session, /attachSessionImages|sessionImagesFromPrompt/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /带上图片|sessionImagesFromPrompt|canAttachSessionImages/);
});
