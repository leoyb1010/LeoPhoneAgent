import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { lastFinishedEdit, peekReloadedToast, samePeekFile, shouldReloadPeek } from './session-peek-sync';
import type { FlowRow } from './model';

const edit = (file: string, extra: Partial<Extract<FlowRow, { k: 'edit' }>> = {}): FlowRow => ({
  k: 'edit', key: file, toolUseId: null, tool: 'edit', file, output: '', running: false, error: false, ...extra,
});

test('预览会跟上刚写的', () => {
  assert.equal(samePeekFile('src/a.ts', 'src/a.ts'), true);
  assert.equal(samePeekFile('src/a.ts', '/tmp/proj/src/a.ts'), true);
  assert.equal(samePeekFile('src/a.ts', 'src/b.ts'), false);
  assert.equal(shouldReloadPeek({ machine: 'local', focusFile: 'src/a.ts', dirty: false, written: 'src/a.ts' }), true);
  assert.equal(shouldReloadPeek({ machine: 'local', focusFile: 'src/a.ts', dirty: true, written: 'src/a.ts' }), false);
  assert.equal(shouldReloadPeek({ machine: 'phone', focusFile: 'src/a.ts', dirty: false, written: 'src/a.ts' }), false);
  assert.deepEqual(lastFinishedEdit([
    edit('old.ts', { key: '1' }),
    edit('src/a.ts', { key: '2', running: true }),
    edit('src/a.ts', { key: '3' }),
  ]), { file: 'src/a.ts', key: '3' });
  assert.equal(lastFinishedEdit([edit('src/a.ts', { error: true })]), null);
  assert.match(peekReloadedToast('src/a.ts'), /a\.ts/);
});

test('2.0 跟上预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /shouldReloadPeek|peekReloadedToast/);
  assert.match(app, /setPeekTick/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /预览已跟上|peekReloaded|peek-sync/);
});
