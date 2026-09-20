import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { attachSessionImages, imagePathsInPrompt, resolveSessionImagePath, sessionImagesFromPrompt } from './session-vision.ts';

test('发出去会带上图片', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leocodebox-vision-'));
  const file = path.join(root, 'leo-paste-ok.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(imagePathsInPrompt(`看下 ${file}`)[0], file);
  assert.equal(resolveSessionImagePath('leo-paste-ok.png', root), file);
  assert.equal(resolveSessionImagePath('../secret.png', root), null);
  const images = sessionImagesFromPrompt(`看下 leo-paste-ok.png`, root);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.type, 'image');
  assert.equal(images[0]?.mimeType, 'image/png');
  assert.ok(images[0]?.data);
  const frame = attachSessionImages({ type: 'prompt', message: '看下 leo-paste-ok.png' }, '看下 leo-paste-ok.png', root);
  assert.equal(Array.isArray(frame.images) ? frame.images.length : 0, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
