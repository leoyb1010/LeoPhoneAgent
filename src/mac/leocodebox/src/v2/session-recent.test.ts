import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { recentDropToast } from './session-recent';

test('把目录丢到程序坞就能开，不进输入栏', () => {
  assert.match(recentDropToast(), /程序坞/);
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  const pkg = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
  assert.match(app, /onLeoScheme/);
  assert.match(main, /['"]open-file['"]/);
  assert.match(main, /cwdFromDroppedPath|rememberRecentCwd/);
  assert.match(pkg, /public\.folder/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /丢到程序坞|已从程序坞打开目录/);
});
