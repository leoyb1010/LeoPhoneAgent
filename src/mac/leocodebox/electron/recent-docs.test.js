import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cwdFromDroppedPath, folderDocumentTypes, rememberRecentCwd } from './recent-docs.js';

test('丢到程序坞的是文件就开它所在的目录', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'leo-recent-'));
  const file = path.join(root, 'note.txt');
  writeFileSync(file, 'ok');
  mkdirSync(path.join(root, 'sub'));
  assert.equal(cwdFromDroppedPath(root), root);
  assert.equal(cwdFromDroppedPath(file), root);
  assert.equal(cwdFromDroppedPath(''), '');
  assert.equal(cwdFromDroppedPath('  /missing/proj  '), '/missing/proj');
});

test('打开过的目录会进最近使用', () => {
  const seen = [];
  assert.equal(rememberRecentCwd({ addRecentDocument: (cwd) => seen.push(cwd) }, '/Users/leo/proj'), true);
  assert.deepEqual(seen, ['/Users/leo/proj']);
  assert.equal(rememberRecentCwd({}, '/Users/leo/proj'), false);
  assert.equal(rememberRecentCwd({ addRecentDocument() {} }, ''), false);
});

test('包装认文件夹，装机壳挂上了丢到程序坞', () => {
  const types = folderDocumentTypes();
  assert.equal(types[0].LSItemContentTypes.includes('public.folder'), true);
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.match(main, /open-file/);
  assert.match(main, /addRecentDocument|rememberRecentCwd/);
  assert.match(main, /cwdFromDroppedPath/);
  assert.match(pkg, /public\.folder/);
  assert.doesNotMatch(main, /new Tray\(/);
});
