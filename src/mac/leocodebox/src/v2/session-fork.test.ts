import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canForkSession, forkSeedText, forkSessionToast, forkTitle } from './session-fork';

test('本机有目录、有说过话才能分出一条', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '先改登录', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '改完了', streaming: false },
    { k: 'edit' as const, key: '3', toolUseId: null, tool: 'write', file: 'src/login.ts', output: '', running: false, error: false },
    { k: 'user' as const, key: '4', text: '再补测试', mode: 'follow_up' as const },
  ];
  assert.equal(canForkSession('local', '/tmp/app', rows), true);
  assert.equal(canForkSession('fold', '/tmp/app', rows), false);
  assert.equal(canForkSession('local', '', rows), false);
  assert.equal(canForkSession('local', '/tmp/app', []), false);
  assert.equal(forkTitle('修登录'), '修登录（分出来）');
  const seed = forkSeedText({ title: '修登录', cwd: '/tmp/app', model: 'xai/grok', rows });
  assert.match(seed, /从「修登录」分出来/);
  assert.match(seed, /目录: \/tmp\/app/);
  assert.match(seed, /你: 先改登录/);
  assert.match(seed, /模型: 改完了/);
  assert.match(seed, /写过: src\/login.ts/);
  assert.doesNotMatch(seed, /再补测试/);
  assert.equal(forkSessionToast('修登录（分出来）'), '已分出「修登录（分出来）」');
});

test('2.0 壳接上了从这里分一条，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /forkSeedText/);
  assert.match(app, /从这里分一条/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /从这里分一条/);
});
