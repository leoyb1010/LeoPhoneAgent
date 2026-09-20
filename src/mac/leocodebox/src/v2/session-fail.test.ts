import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canJumpLastFail, jumpLastFailToast, lastFailedKey, lastFailedRow } from './session-fail';

const tool = (key: string, error = false, running = false) => ({
  k: 'tool' as const, key, toolUseId: key, tool: 'bash', preview: `cmd-${key}`, output: error ? 'boom' : 'ok', running, error,
});
const edit = (file: string, error = false, running = false) => ({
  k: 'edit' as const, key: file, toolUseId: null, tool: 'write', file, output: '', running, error,
});

test('本机才能跳到刚失败的，跳过还在跑的，远程不算', () => {
  const rows = [
    edit('old.txt', true),
    tool('run', true, true),
    { k: 'ai' as const, key: 'a', text: '还在说', streaming: false },
    { k: 'sys' as const, key: 's', text: '失败:超时', tone: 'error' as const },
  ];
  assert.equal(lastFailedKey(rows), 's');
  assert.equal(lastFailedRow([edit('notes/idea.md', true)])?.k, 'edit');
  assert.equal(lastFailedKey([tool('ok'), edit('x.txt')]), '');
  assert.equal(lastFailedKey([]), '');
  assert.equal(canJumpLastFail('local', [tool('x', true)]), true);
  assert.equal(canJumpLastFail('fold', [tool('x', true)]), false);
  assert.equal(canJumpLastFail('local', [tool('ok')]), false);
  assert.equal(jumpLastFailToast(edit('notes/idea.md', true)), '已跳到 idea.md');
  assert.equal(jumpLastFailToast(tool('x', true)), '已跳到 cmd-x');
  assert.equal(jumpLastFailToast({ k: 'sys', key: 's', text: '失败', tone: 'error' }), '已跳到刚失败的');
});

test('2.0 壳接上了看刚失败的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /lastFailedRow/);
  assert.match(app, /看刚失败的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /看刚失败的/);
});
