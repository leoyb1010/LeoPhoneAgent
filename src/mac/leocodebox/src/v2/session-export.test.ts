import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canExportSession, exportFileName, exportSessionToast, flowRowsToMarkdown } from './session-export';

test('只有本机有你或模型说话才能记下对话', () => {
  const rows = [{ k: 'user' as const, key: '1', text: '修登录' }];
  assert.equal(canExportSession('local', rows), true);
  assert.equal(canExportSession('fold', rows), false);
  assert.equal(canExportSession('local', []), false);
  assert.equal(exportFileName('修 登录!'), 'leo-对话-修-登录.md');
  assert.equal(exportFileName(''), 'leo-对话.md');
  assert.match(exportSessionToast('leo-对话.md'), /leo-对话/);
});

test('流水折成能带走的 markdown', () => {
  const markdown = flowRowsToMarkdown({
    title: '修登录',
    cwd: '/tmp/app',
    model: 'Composer 2',
    rows: [
      { k: 'user', key: '1', text: '只改登录页' },
      { k: 'ai', key: '2', text: '改完了', streaming: false },
      { k: 'edit', key: '3', toolUseId: null, tool: 'edit', file: 'src/login.ts', output: '', running: false, error: false },
      { k: 'think', key: '4', text: '心里话', streaming: false },
    ],
  });
  assert.match(markdown, /# 修登录/);
  assert.match(markdown, /目录: \/tmp\/app/);
  assert.match(markdown, /只改登录页/);
  assert.match(markdown, /改完了/);
  assert.match(markdown, /src\/login.ts/);
  assert.doesNotMatch(markdown, /心里话/);
  assert.throws(() => flowRowsToMarkdown({ rows: [{ k: 'think', key: '1', text: 'x', streaming: false }] }), /可记下的对话/);
});

test('2.0 壳接上了记下这次对话', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /exportLocalTalk/);
  assert.match(app, /canExportSession/);
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/export/);
  assert.match(routes, /writeSessionExport/);
});
