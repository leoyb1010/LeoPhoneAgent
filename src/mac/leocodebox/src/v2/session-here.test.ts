import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canShowSameCwd, sameCwdPickerHint, sameCwdSessions, sameCwdToast, sameSessionCwd, sessionCwdKey } from './session-here';

const row = (id: string, cwd: string, machine = 'local', title = id) => ({
  machine, s: { session_id: id, cwd, title, updated_at: id === 'b' ? 20 : 10 },
});

test('本机才能翻出同目录的别的会话，斜杠和当前这条不算', () => {
  assert.equal(sessionCwdKey('/tmp/foo/'), '/tmp/foo');
  assert.equal(sameSessionCwd('/tmp/foo/', '/tmp/foo'), true);
  assert.equal(sameSessionCwd('/tmp/foo', '/tmp/bar'), false);
  const peers = sameCwdSessions([
    row('a', '/tmp/foo'),
    row('b', '/tmp/foo/'),
    row('c', '/tmp/bar'),
    row('d', '/tmp/foo', 'fold'),
  ], '/tmp/foo', 'a');
  assert.deepEqual(peers.map((item) => item.session_id), ['b']);
  assert.equal(canShowSameCwd('local', peers), true);
  assert.equal(canShowSameCwd('fold', peers), false);
  assert.equal(canShowSameCwd('local', []), false);
  assert.equal(sameCwdPickerHint(2), '2 条同目录会话');
  assert.equal(sameCwdToast('修登录'), '已打开「修登录」');
});

test('2.0 壳接上了这个目录的会话，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /sameCwdSessions/);
  assert.match(app, /这个目录的会话/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /这个目录的会话/);
});
