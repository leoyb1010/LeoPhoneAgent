import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenLastRead, lastReadFile, openLastReadToast, readFileFromRow } from './session-read';

const read = (file: string, running = false, tool = 'read') => ({
  k: 'tool' as const, key: file, toolUseId: file, tool, preview: file, output: 'ok', running, error: false,
});

test('本机才能打开刚读过的文件，跳过还在读的和命令行', () => {
  assert.equal(lastReadFile([
    read('old.txt'),
    read('src/App.tsx', true),
    { k: 'tool' as const, key: 'b', toolUseId: '1', tool: 'bash', preview: 'ls', output: 'ok', running: false, error: false },
    { k: 'edit' as const, key: 'e', toolUseId: null, tool: 'write', file: 'ART31.txt', output: '', running: false, error: false },
  ]), 'old.txt');
  assert.equal(lastReadFile([read('notes/idea.md', false, 'Read')]), 'notes/idea.md');
  assert.equal(lastReadFile([read('package.json', false, 'read_file')]), 'package.json');
  assert.equal(readFileFromRow(read('src/a.ts')), 'src/a.ts');
  assert.equal(readFileFromRow(read('ls -la')), '');
  assert.equal(lastReadFile([]), '');
  assert.equal(canOpenLastRead('local', [read('ART31.txt')]), true);
  assert.equal(canOpenLastRead('fold', [read('ART31.txt')]), false);
  assert.equal(canOpenLastRead('local', []), false);
  assert.equal(openLastReadToast('notes/idea.md'), '已打开 idea.md');
});

test('2.0 壳接上了打开刚读的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  assert.match(app, /lastReadFile/);
  assert.match(app, /打开刚读的/);
  assert.match(flow, /onOpen/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /打开刚读的/);
});
