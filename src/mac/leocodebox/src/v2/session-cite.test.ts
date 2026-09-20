import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canCiteSessionFiles, citePathsInPrompt } from './session-cite';

test('提到的文件会一起送进去', () => {
  assert.equal(citePathsInPrompt('改 src/a.ts')[0], 'src/a.ts');
  assert.equal(citePathsInPrompt('看下 `/tmp/work/README.md`')[0], '/tmp/work/README.md');
  assert.deepEqual(citePathsInPrompt('https://example.com/a.ts'), []);
  assert.deepEqual(citePathsInPrompt('看下 shot.png'), []);
  assert.equal(canCiteSessionFiles({ machine: 'local', prompt: 'notes/idea.md' }), true);
  assert.equal(canCiteSessionFiles({ machine: 'phone', prompt: 'notes/idea.md' }), false);
  assert.equal(canCiteSessionFiles({ machine: 'local', prompt: '没有文件' }), false);
});

test('2.0 带正文不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const session = readFileSync(fileURLToPath(new URL('../../server/modules/leophone/harness-session.service.ts', import.meta.url)), 'utf8');
  assert.match(session, /attachSessionCites|sessionCiteText/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /一起送进去|sessionCiteText|canCiteSessionFiles/);
});
