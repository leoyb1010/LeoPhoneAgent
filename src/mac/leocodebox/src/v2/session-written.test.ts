import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenLastWritten, lastWrittenFile, openLastWrittenToast } from './session-written';

const edit = (file: string, running = false) => ({
  k: 'edit' as const, key: file, toolUseId: null, tool: 'write', file, output: '', running, error: false,
});

test('本机才能打开刚写下的文件，跳过还在写的', () => {
  assert.equal(lastWrittenFile([
    edit('old.txt'),
    edit('ART31.txt', true),
    { k: 'tool' as const, key: 't', toolUseId: '1', tool: 'bash', preview: 'ls', output: 'ok', running: false, error: false },
  ]), 'old.txt');
  assert.equal(lastWrittenFile([edit('notes/idea.md')]), 'notes/idea.md');
  assert.equal(lastWrittenFile([]), '');
  assert.equal(canOpenLastWritten('local', [edit('ART31.txt')]), true);
  assert.equal(canOpenLastWritten('fold', [edit('ART31.txt')]), false);
  assert.equal(canOpenLastWritten('local', []), false);
  assert.equal(openLastWrittenToast('notes/idea.md'), '已打开 idea.md');
});

test('2.0 壳接上了打开刚写的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /lastWrittenFile/);
  assert.match(app, /打开刚写的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /打开刚写的/);
});
