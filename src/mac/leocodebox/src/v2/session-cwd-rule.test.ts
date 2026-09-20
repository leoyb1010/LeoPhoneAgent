import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyEvent, emptyView } from './model';
import { applyCwdRule, canSetCwdRule, clipCwdRule, cwdRuleToast } from './session-cwd-rule';
import { applySessionRule } from './session-rule';

test('只有本机才能写下目录规矩，新开会话也能带着', () => {
  assert.equal(canSetCwdRule('local'), true);
  assert.equal(canSetCwdRule('fold'), false);
  assert.equal(clipCwdRule('  用中文\n'), '用中文');
  assert.equal(applyCwdRule('改按钮', '用中文回答'), '【目录规矩】\n用中文回答\n\n改按钮');
  assert.equal(applyCwdRule('【目录规矩】\n用中文回答\n\n改按钮', '用中文回答'), '【目录规矩】\n用中文回答\n\n改按钮');
  const stacked = applyCwdRule(applySessionRule('改按钮', '先跑测试'), '用中文回答');
  assert.match(stacked, /^【目录规矩】/);
  assert.match(stacked, /【会话规矩】/);
  assert.match(cwdRuleToast('用中文'), /目录规矩/);
  const view = applyEvent(emptyView(), { event: 'session.cwd_rule', cwd_rule: '用中文回答' });
  assert.equal(view.cwdRule, '用中文回答');
});

test('2.0 壳接上了目录规矩，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /setLocalCwdRule/);
  assert.match(app, /这个目录的规矩/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这个目录的规矩/);
});
