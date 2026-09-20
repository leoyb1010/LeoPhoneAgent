import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applySessionRule, readRuleSidecar, writeRuleSidecar } from './session-rule.js';

test('管理器接上了 setRule，路由挂在本机 rule', () => {
  const service = fs.readFileSync(new URL('./harness-session.service.ts', import.meta.url), 'utf8');
  assert.match(service, /setRule\(/);
  assert.match(service, /applyOutgoingRules/);
  const routes = fs.readFileSync(new URL('./workbench.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /\/sessions\/:sessionId\/rule/);
  assert.match(routes, /setRule/);
});

test('规矩旁路文件能记下也能清掉，发送时会带着', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-rule-'));
  const log = path.join(dir, 'hs_a.ndjson');
  assert.equal(writeRuleSidecar(log, '  用中文回答  '), '用中文回答');
  assert.equal(readRuleSidecar(log), '用中文回答');
  assert.equal(fs.readFileSync(path.join(dir, 'hs_a.rule'), 'utf8'), '用中文回答');
  assert.equal(applySessionRule('改按钮', '用中文回答'), '【会话规矩】\n用中文回答\n\n改按钮');
  assert.equal(writeRuleSidecar(log, '   '), '');
  assert.equal(readRuleSidecar(log), '');
  assert.equal(fs.existsSync(path.join(dir, 'hs_a.rule')), false);
});
