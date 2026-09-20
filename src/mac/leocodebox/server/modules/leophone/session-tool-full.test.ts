import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sessionToolFullOutput, sessionToolFullPath } from './session-tool-full.js';

test('截断的输出能看全', () => {
  const file = `/tmp/pi-bash-${Date.now()}.log`;
  fs.writeFileSync(file, `${'head\n'}PASS 99\n`);
  assert.equal(sessionToolFullPath({ details: { fullOutputPath: file } }), path.resolve(file));
  assert.equal(sessionToolFullPath({ details: { fullOutputPath: '/etc/passwd' } }), '');
  const body = sessionToolFullOutput({ details: { fullOutputPath: file }, content: [{ type: 'text', text: 'head\n' }] }, 'head\n');
  assert.match(body, /PASS 99/);
  fs.rmSync(file, { force: true });
});
