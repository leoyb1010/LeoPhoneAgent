import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canAcceptSessionDrop, mentionDroppedFile, pasteImageName, sanitizeDropName } from './session-drop.ts';

test('只有本机且有目录才能往会话里放文件', () => {
  assert.equal(canAcceptSessionDrop({ machine: 'local', cwd: '/tmp/proj' }), true);
  assert.equal(canAcceptSessionDrop({ machine: 'fold', cwd: '/tmp/proj' }), false);
  assert.equal(canAcceptSessionDrop({ machine: 'local', cwd: '  ' }), false);
});

test('文件名去掉路径和怪字符;粘贴截图带时间戳', () => {
  assert.equal(sanitizeDropName('../../etc/hosts'), 'hosts');
  assert.equal(sanitizeDropName(''), 'dropped.bin');
  assert.match(pasteImageName(new Date('2026-09-20T10:11:12')), /leo-paste-20260920-101112\.png/);
});

test('放入的路径接到草稿末尾,已经有了不重复', () => {
  assert.equal(mentionDroppedFile('', '/tmp/a.png'), '/tmp/a.png');
  assert.equal(mentionDroppedFile('看下\n', '/tmp/a.png'), '看下\n/tmp/a.png');
  assert.equal(mentionDroppedFile('已有 /tmp/a.png', '/tmp/a.png'), '已有 /tmp/a.png');
});

test('2.0 壳输入框能拖入、粘贴截图、选文件放进本机目录', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const api = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /onPaste=\{onComposerPaste\}/);
  assert.match(app, /onDrop=\{onComposerDrop\}/);
  assert.match(app, /放入文件/);
  assert.match(app, /粘贴截图/);
  assert.match(api, /\/leophone\/local\/drop/);
  assert.match(main, /leocodebox-desktop:save-drop/);
  assert.match(main, /clipboard\.readImage/);
});
