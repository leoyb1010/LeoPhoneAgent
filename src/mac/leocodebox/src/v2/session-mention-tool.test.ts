import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canMentionLastTool, lastToolOutput, mentionLastTool, mentionLastToolToast } from './session-mention-tool';

test('已经打完的命令输出可以带进这句话', () => {
  const rows = [
    { k: 'tool' as const, key: '1', toolUseId: 'a', tool: 'bash', preview: 'ls -la', output: '', running: true, error: false },
    { k: 'tool' as const, key: '2', toolUseId: 'b', tool: 'bash', preview: 'cat ART31.txt', output: '2.0.31-ok\n', running: false, error: false },
    { k: 'tool' as const, key: '3', toolUseId: 'c', tool: 'bash', preview: 'pwd', output: '', running: false, error: false },
  ];
  assert.equal(canMentionLastTool(rows), true);
  assert.equal(canMentionLastTool([]), false);
  assert.equal(lastToolOutput(rows), '$ cat ART31.txt\n2.0.31-ok');
  assert.equal(mentionLastTool('看这个', lastToolOutput(rows)), '看这个\n$ cat ART31.txt\n2.0.31-ok');
  assert.match(mentionLastToolToast(), /刚打出来的/);
});

test('2.0 壳接上了带上刚打出来的，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /mentionLastTool/);
  assert.match(app, /带上刚打出来的/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /带上刚打出来的/);
});
