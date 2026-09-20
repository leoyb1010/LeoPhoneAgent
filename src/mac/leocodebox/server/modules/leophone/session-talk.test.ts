import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { searchTalkLogs, talkLineMatches } from './session-talk.js';

test('只匹配会话里说过的话，工具行不算', () => {
  assert.equal(talkLineMatches('{"event":"user.message","text":"修一下登录"}', '登录'), '修一下登录');
  assert.equal(talkLineMatches('{"event":"message.delta","delta":"已经改好登录"}', '登录'), '已经改好登录');
  assert.equal(talkLineMatches('{"event":"tool.started","preview":"登录"}', '登录'), null);
  assert.equal(talkLineMatches('{"event":"user.message","text":"你好"}', '登录'), null);
});

test('本机日志能按说过的话找到会话', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-talk-'));
  try {
    const a = path.join(dir, 'hs_a.ndjson');
    const b = path.join(dir, 'hs_b.ndjson');
    await fs.writeFile(a, `${JSON.stringify({ event: 'user.message', text: '修一下登录' })}\n`);
    await fs.writeFile(b, `${JSON.stringify({ event: 'user.message', text: '看看天气' })}\n`);
    const hits = await searchTalkLogs([
      { sessionId: 'hs_a', logPath: a },
      { sessionId: 'hs_b', logPath: b },
    ], '登录');
    assert.deepEqual(hits.map((hit) => hit.session_id), ['hs_a']);
    assert.match(hits[0]!.text, /登录/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
