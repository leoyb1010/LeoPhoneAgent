import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { applySessionRule, canSetSessionRule, clipSessionRule, ruleSessionToast } from './session-rule';

test('本机才能写下规矩，空的就是去掉', () => {
  assert.equal(canSetSessionRule('local'), true);
  assert.equal(canSetSessionRule('fold'), false);
  assert.equal(clipSessionRule('  用中文\n回答  '), '用中文\n回答');
  assert.equal(clipSessionRule('x'.repeat(500)).length, 400);
  assert.equal(applySessionRule('改按钮', '用中文'), '【会话规矩】\n用中文\n\n改按钮');
  assert.equal(applySessionRule('【会话规矩】\n用中文\n\n改按钮', '用中文'), '【会话规矩】\n用中文\n\n改按钮');
  assert.equal(applySessionRule('改按钮', ''), '改按钮');
  assert.match(ruleSessionToast('用中文'), /记下/);
  assert.match(ruleSessionToast(''), /去掉/);
});

test('规矩事件会改掉会话上的那句', () => {
  const view = applyEvent(emptyView(), { event: 'session.rule', rule: '不要动测试' });
  assert.equal(view.rule, '不要动测试');
});

test('2.0 壳接上了会话规矩，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /setLocalSessionRule/);
  assert.match(app, /这条会话的规矩/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这条会话的规矩/);
});
