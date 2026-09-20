import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowSessionPulse, sessionPulseLabel, sessionPulseToast, sessionTurnCount } from './session-pulse';

test('本机才能看这条聊了多少，接着的不算一轮', () => {
  const rows = [
    { k: 'user' as const, key: '1', text: '先改登录', mode: 'prompt' as const },
    { k: 'ai' as const, key: '2', text: '好', streaming: false },
    { k: 'user' as const, key: '3', text: '再补测试', mode: 'follow_up' as const },
    { k: 'user' as const, key: '4', text: '发了', mode: 'prompt' as const },
  ];
  assert.equal(sessionTurnCount(rows), 2);
  assert.equal(sessionPulseLabel({ rows, createdAt: 1000, nowSec: 1000 + 2 * 3600 }), '2 轮 · 2 小时');
  assert.equal(sessionPulseLabel({ rows: [], createdAt: 1000, nowSec: 1030 }), '不到 1 分钟');
  assert.equal(canShowSessionPulse('local', rows, 1000), true);
  assert.equal(canShowSessionPulse('fold', rows, 1000), false);
  assert.equal(canShowSessionPulse('local', [], 0), false);
  assert.equal(sessionPulseToast('2 轮 · 2 小时'), '这条 2 轮 · 2 小时');
});

test('2.0 壳接上了这条聊了多少，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /sessionPulseLabel/);
  assert.match(app, /这条聊了多少/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这条聊了多少/);
});
