import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { applyOutgoingRules, readCwdRuleSidecar, writeCwdRuleSidecar } from './session-cwd-rule.js';

test('同一目录的规矩写一次，另一条会话也能读到', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-cwd-rule-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-cwd-rule-'));
  const previous = process.env.LEOAGENT_HOME;
  process.env.LEOAGENT_HOME = home;
  try {
    assert.equal(writeCwdRuleSidecar(dir, '用中文回答'), '用中文回答');
    assert.equal(readCwdRuleSidecar(dir), '用中文回答');
    assert.equal(writeCwdRuleSidecar(dir, ''), '');
    assert.equal(readCwdRuleSidecar(dir), '');
  } finally {
    if (previous === undefined) delete process.env.LEOAGENT_HOME;
    else process.env.LEOAGENT_HOME = previous;
  }
});

test('发给内核时目录规矩包在会话规矩外面', () => {
  const text = applyOutgoingRules('改按钮', '先跑测试', '用中文回答');
  assert.equal(text, '【目录规矩】\n用中文回答\n\n【会话规矩】\n先跑测试\n\n改按钮');
});

test('管理器接上了 setCwdRule，路由挂在本机 cwd-rule', () => {
  const service = fs.readFileSync(fileURLToPath(new URL('./harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(service, /applyOutgoingRules/);
  assert.match(service, /setCwdRule/);
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/cwd-rule/);
});
