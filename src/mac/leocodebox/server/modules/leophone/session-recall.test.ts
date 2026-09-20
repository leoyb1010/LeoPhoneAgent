import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { HarnessManager, HarnessSession } from './harness-session.service.js';
import type { HarnessSpec } from './harness-specs.js';
import { writeTitleSidecar } from './session-title.js';

const FAKE_SPEC: HarnessSpec = {
  key: 'claude', displayName: 'Claude Code', executable: 'claude',
  args: [], dialect: 'claude_stream_json',
};

test('拿掉的会话可以列出来再找回来，标题一起回来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-recall-'));
  const logPath = path.join(dir, 'hs_gone.ndjson');
  fs.writeFileSync(logPath, [
    JSON.stringify({ event: 'session.created', harness: 'pi', cwd: '/tmp/recall', seq: 1, session_id: 'hs_gone', timestamp: 100 }),
    JSON.stringify({ event: 'user.message', text: '找回我', mode: 'prompt', seq: 2, session_id: 'hs_gone', timestamp: 200 }),
    '',
  ].join('\n'));
  writeTitleSidecar(logPath, '修登录');
  const manager = new HarnessManager(dir);
  await manager.ready();
  const existing = manager.get('hs_gone');
  if (existing) {
    existing.status = 'completed';
  } else {
    manager.sessions.set('hs_gone', new HarnessSession({
      sessionId: 'hs_gone', spec: FAKE_SPEC, cwd: '/tmp/recall', logPath, status: 'completed',
    }));
  }
  await manager.forget('hs_gone');
  assert.equal(manager.get('hs_gone'), undefined);
  assert.ok(fs.existsSync(path.join(dir, 'forgotten', 'hs_gone.ndjson')));
  const listed = await manager.listForgotten();
  assert.equal(listed.some((row) => row.session_id === 'hs_gone' && row.title === '修登录'), true);
  const recalled = await manager.recall('hs_gone');
  assert.equal(recalled.session_id, 'hs_gone');
  assert.equal(recalled.title, '修登录');
  assert.ok(manager.get('hs_gone'));
  assert.equal(fs.existsSync(path.join(dir, 'forgotten', 'hs_gone.ndjson')), false);
  assert.ok(fs.existsSync(path.join(dir, 'hs_gone.ndjson')));
  assert.ok(fs.existsSync(path.join(dir, 'hs_gone.title')));
  await assert.rejects(() => manager.recall('hs_gone'), /已经在左栏/);
});

test('管理器接上了 listForgotten / recall，路由挂在本机 forgotten 和 recall', () => {
  const service = fs.readFileSync(fileURLToPath(new URL('./harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(service, /async listForgotten\(/);
  assert.match(service, /async recall\(/);
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/forgotten/);
  assert.match(routes, /\/leophone\/local\/sessions\/:sessionId\/recall/);
  assert.match(routes, /recallForgottenLocalSession/);
});
