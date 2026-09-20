import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { HarnessManager, HarnessSession } from './harness-session.service.js';
import type { HarnessSpec } from './harness-specs.js';

const FAKE_SPEC: HarnessSpec = {
  key: 'claude', displayName: 'Claude Code', executable: 'claude',
  args: [], dialect: 'claude_stream_json',
};

test('一次清掉只收已经结束的会话，idle / 进行中不动', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leophone-forget-ended-'));
  const manager = new HarnessManager(dir);
  await manager.ready();
  manager.sessions.set('hs_done', new HarnessSession({
    sessionId: 'hs_done', spec: FAKE_SPEC, cwd: '/tmp', logPath: path.join(dir, 'hs_done.ndjson'), status: 'completed',
  }));
  manager.sessions.set('hs_fail', new HarnessSession({
    sessionId: 'hs_fail', spec: FAKE_SPEC, cwd: '/tmp', logPath: path.join(dir, 'hs_fail.ndjson'), status: 'failed',
  }));
  manager.sessions.set('hs_idle', new HarnessSession({
    sessionId: 'hs_idle', spec: FAKE_SPEC, cwd: '/tmp', logPath: path.join(dir, 'hs_idle.ndjson'), status: 'idle',
  }));
  manager.sessions.set('hs_run', new HarnessSession({
    sessionId: 'hs_run', spec: FAKE_SPEC, cwd: '/tmp', logPath: path.join(dir, 'hs_run.ndjson'), status: 'running',
  }));
  const result = await manager.forgetEnded(['hs_done', 'hs_fail', 'hs_idle', 'hs_run']);
  assert.deepEqual(result.ids.sort(), ['hs_done', 'hs_fail']);
  assert.equal(manager.get('hs_done'), undefined);
  assert.ok(manager.get('hs_idle'));
  assert.ok(manager.get('hs_run'));
});

test('管理器接上了 forgetEnded，路由挂在本机 forget-ended', () => {
  const service = fs.readFileSync(fileURLToPath(new URL('./harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(service, /async forgetEnded\(/);
  const routes = fs.readFileSync(fileURLToPath(new URL('./workbench.routes.ts', import.meta.url)), 'utf8');
  assert.match(routes, /\/leophone\/local\/forget-ended/);
  assert.match(routes, /forgetEndedLocalSessions/);
});
