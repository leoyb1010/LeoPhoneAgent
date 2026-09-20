import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canImportTalk, importSeedText, importTalkName, importTitle, looksLikeTalkExport } from './session-import-talk';

test('本机才接回记下的对话，只认 leo-对话 markdown', () => {
  assert.equal(canImportTalk('local', '/tmp/work'), true);
  assert.equal(canImportTalk('fold', '/tmp/work'), false);
  assert.equal(canImportTalk('local', ''), false);
  assert.equal(looksLikeTalkExport('leo-对话-修登录.md'), true);
  assert.equal(looksLikeTalkExport('README.md'), false);
  assert.equal(importTalkName('notes/leo-对话.md'), 'leo-对话.md');
  assert.equal(importTalkName('README.md'), '');
  assert.equal(importTitle('leo-对话-修登录.md'), '修登录（接回来）');
  assert.match(importSeedText({ name: 'leo-对话.md', markdown: '# 一次\n\n你好' }), /接回记下的对话/);
  assert.throws(() => importSeedText({ name: 'leo-对话.md', markdown: '   ' }), /空的/);
});

test('2.0 壳接上了接回记下的对话，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const api = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
  const routes = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(app, /canImportTalk/);
  assert.match(app, /接回记下的对话/);
  assert.match(api, /importLocalTalk/);
  assert.match(routes, /readSessionImport/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /接回记下的对话/);
});
