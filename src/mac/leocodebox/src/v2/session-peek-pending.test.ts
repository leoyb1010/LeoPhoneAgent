import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { FlowRow } from './model';
import { canPeekPendingEdit, pendingEditFile } from './session-peek-pending';

test('要批准时先看到那份文件', () => {
  const rows: FlowRow[] = [
    { k: 'edit', key: '1', toolUseId: 't1', tool: 'write', file: 'src/a.ts', output: '', running: true, error: false },
    { k: 'ap', key: '2', approvalId: 'a1', title: '写入', command: 'write src/a.ts', tool: 'write', cwd: '/tmp', host: '', choices: ['once', 'deny'] },
  ];
  assert.equal(pendingEditFile(rows), 'src/a.ts');
  assert.equal(pendingEditFile([]), '');
  assert.equal(canPeekPendingEdit({
    machine: 'local', status: 'waiting_for_approval', dirty: false, focusFile: null, pendingFile: 'src/a.ts',
  }), true);
  assert.equal(canPeekPendingEdit({
    machine: 'local', status: 'waiting_for_approval', dirty: false, focusFile: 'src/a.ts', pendingFile: 'src/a.ts',
  }), false);
  assert.equal(canPeekPendingEdit({
    machine: 'local', status: 'waiting_for_approval', dirty: true, focusFile: null, pendingFile: 'src/a.ts',
  }), false);
  assert.equal(canPeekPendingEdit({
    machine: 'phone', status: 'waiting_for_approval', dirty: false, focusFile: null, pendingFile: 'src/a.ts',
  }), false);
  assert.equal(canPeekPendingEdit({
    machine: 'local', status: 'running', dirty: false, focusFile: null, pendingFile: 'src/a.ts',
  }), false);
});

test('2.0 待批预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canPeekPendingEdit/);
  assert.match(app, /pendingEditFile/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /要批准|pendingEdit|先看/);
});
