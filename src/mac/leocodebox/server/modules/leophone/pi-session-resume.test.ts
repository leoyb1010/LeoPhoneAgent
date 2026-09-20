import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildArgs, findPiSessionFile, readPiSessionHeader, sameSessionCwd } from './pi-runtime.js';

function writeSession(dir: string, name: string, id: string, cwd: string, timestamp: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd })}\n`);
  return file;
}

test('buildArgs 新开会话钉死 --session-id,续聊改走 --session 文件', () => {
  const created = buildArgs({ sessionId: 'hs_abc', cwd: '/tmp/x', home: '/tmp', model: { provider: 'xai', modelId: 'grok-4.6' }, policy: 'default' });
  assert.equal(created.includes('--session-id'), true);
  assert.equal(created[created.indexOf('--session-id') + 1], 'hs_abc');
  assert.equal(created.includes('--session'), false);
  assert.equal(created.includes('--provider'), true);

  const resumed = buildArgs({
    sessionId: 'hs_abc', cwd: '/tmp/x', home: '/tmp', model: null, policy: 'default',
    resumeSession: '/tmp/pi/sessions/old.jsonl',
  });
  assert.equal(resumed.includes('--session-id'), false);
  assert.equal(resumed[resumed.indexOf('--session') + 1], '/tmp/pi/sessions/old.jsonl');
});

test('findPiSessionFile 先认 id,再认同目录且开局时间靠近的文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-pi-resume-'));
  const created = Date.parse('2026-09-20T07:00:16.927Z') / 1000;
  const byId = writeSession(dir, '2026-09-20T07-00-16-927Z_hs_keep.jsonl', 'hs_keep', '/tmp/work-a', '2026-09-20T07:00:16.927Z');
  writeSession(dir, '2026-09-20T07-00-20-000Z_other.jsonl', 'other-id', '/tmp/work-a', '2026-09-20T07:00:20.000Z');
  writeSession(dir, '2026-09-20T08-00-00-000Z_late.jsonl', 'late-id', '/tmp/work-b', '2026-09-20T08:00:00.000Z');

  assert.equal(findPiSessionFile('hs_keep', '/tmp/work-a', created, dir), byId);

  const byCwd = writeSession(dir, '2026-09-20T07-01-00-000Z_ulid.jsonl', '01abc', '/tmp/work-c', '2026-09-20T07:01:00.000Z');
  const cwdHit = findPiSessionFile('hs_unknown', '/tmp/work-c', Date.parse('2026-09-20T07:01:05.000Z') / 1000, dir);
  assert.equal(cwdHit, byCwd);

  assert.equal(findPiSessionFile('hs_missing', '/tmp/nope', created, dir), null);
  assert.equal(findPiSessionFile('hs_unknown', '/tmp/work-b', created, dir), null);

  const header = readPiSessionHeader(byId);
  assert.equal(header?.id, 'hs_keep');
  assert.equal(sameSessionCwd('/tmp/work-a', '/tmp/work-a'), true);
});
