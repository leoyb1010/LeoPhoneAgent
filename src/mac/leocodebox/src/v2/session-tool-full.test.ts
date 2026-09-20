import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { sessionToolFullPath } from './session-tool-full';

test('截断的输出能看全', () => {
  assert.equal(sessionToolFullPath({ details: { fullOutputPath: '/tmp/pi-bash-abc.log' } }), '/tmp/pi-bash-abc.log');
  assert.equal(sessionToolFullPath({ fullOutputPath: '/private/tmp/pi-tool-x.txt' }), '/private/tmp/pi-tool-x.txt');
  assert.equal(sessionToolFullPath({ details: { fullOutputPath: '/etc/passwd' } }), '');
  assert.equal(sessionToolFullPath({ details: { fullOutputPath: '/tmp/other.log' } }), '');
});

test('2.0 全文不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const dialect = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-dialects.ts', import.meta.url)), 'utf8');
  assert.match(dialect, /sessionToolFullOutput/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /看全|sessionToolFullOutput|fullOutputPath/);
});
