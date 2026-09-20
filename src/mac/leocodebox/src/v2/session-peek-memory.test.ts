import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  peekMemoryFile,
  peekMemoryKey,
  peekMemoryToSave,
  peekDraftToRestore,
  writePeekMemory,
} from './session-peek-memory';

test('换会话时预览还在刚才那份', () => {
  assert.equal(peekMemoryKey('local', 'hs_1'), 'local:hs_1');
  assert.equal(peekMemoryKey('local', ''), '');
  assert.deepEqual(peekMemoryToSave({ file: 'src/a.ts', peek: 'old', draft: 'new' }), {
    file: 'src/a.ts', draft: 'new',
  });
  assert.deepEqual(peekMemoryToSave({ file: 'src/a.ts', peek: 'old', draft: 'old' }), { file: 'src/a.ts' });
  assert.equal(peekMemoryToSave({ file: '', peek: 'old', draft: 'new' }), null);
  assert.deepEqual(peekMemoryToSave({ file: 'src/a.ts', peek: '正在读…', draft: 'x' }), { file: 'src/a.ts' });
  const map = new Map();
  writePeekMemory(map, 'local:a', { file: 'src/a.ts', peek: 'old', draft: 'new' });
  writePeekMemory(map, 'local:a', { file: '', peek: null, draft: null });
  assert.equal(peekMemoryFile(map.get('local:a')), 'src/a.ts');
  assert.equal(peekDraftToRestore(map.get('local:a'), 'src/a.ts'), 'new');
  assert.equal(peekDraftToRestore(map.get('local:a'), 'src/b.ts'), null);
});

test('2.0 换会话预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /writePeekMemory/);
  assert.match(app, /peekDraftToRestore/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /换会话|peekMemory|刚才那份/);
});
