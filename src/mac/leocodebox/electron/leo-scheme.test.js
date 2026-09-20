import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseLeoScheme, resolveLeoSchemeCwd } from './leo-scheme.js';

test('只认 leocodebox:// 里的目录', () => {
  assert.equal(parseLeoScheme('https://example.com'), null);
  assert.equal(parseLeoScheme('leocodebox://open'), null);
  assert.deepEqual(parseLeoScheme('leocodebox://open?cwd=/Users/leo/proj'), { cwd: '/Users/leo/proj' });
  assert.deepEqual(parseLeoScheme('leocodebox:///Users/leo/proj'), { cwd: '/Users/leo/proj' });
  assert.equal(resolveLeoSchemeCwd('leocodebox://open?cwd=/etc', os.homedir()), null);
  assert.equal(
    resolveLeoSchemeCwd('leocodebox://open?cwd=~/Documents', os.homedir()),
    path.join(os.homedir(), 'Documents'),
  );
});

test('装机壳挂上了 leocodebox://', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.match(main, /setAsDefaultProtocolClient/);
  assert.match(main, /leocodebox-desktop:open-scheme/);
  assert.match(main, /open-url/);
  assert.match(pkg, /CFBundleURLSchemes/);
  assert.match(pkg, /"leocodebox"/);
});
