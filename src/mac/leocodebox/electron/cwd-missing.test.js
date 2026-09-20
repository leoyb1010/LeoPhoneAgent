import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cwdStillThere } from './cwd-missing.js';

test('能认出目录没了，空路径不当没', () => {
  assert.equal(cwdStillThere(''), true);
  assert.equal(cwdStillThere('/Users/leo/proj', () => ({ isDirectory: () => true })), true);
  assert.equal(cwdStillThere('/Users/leo/gone', () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }), false);
  assert.equal(cwdStillThere('/Users/leo/file.txt', () => ({ isDirectory: () => false })), false);
});

test('装机壳挂上了目录还在不在，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:cwd-exists/);
  assert.match(main, /cwdStillThere/);
  assert.match(preload, /cwdExists/);
  assert.doesNotMatch(main, /new Tray\(/);
});
