import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cliShimBody, cwdFromArgv, pathHasLocalBin, withLocalBinOnPath, zprofilePathLine } from './cli-install.js';

test('shim 用 --cwd 打开目录，不是 leocodebox://', () => {
  const body = cliShimBody('/Applications/leocodebox.app');
  assert.match(body, /leocodebox desktop shim/);
  assert.match(body, /--cwd=/);
  assert.doesNotMatch(body, /leocodebox:\/\//);
  assert.match(body, /\/Applications\/leocodebox\.app/);
});

test('argv 里抽出 --cwd', () => {
  assert.equal(cwdFromArgv(['--cwd=/tmp/foo']), '/tmp/foo');
  assert.equal(cwdFromArgv(['--remote-debugging-port=9458', '--cwd=/Users/leo/src']), '/Users/leo/src');
  assert.equal(cwdFromArgv(['leocodebox://open?cwd=/tmp']), '');
});

test('缺 PATH 时给 zprofile 补一行', () => {
  assert.equal(pathHasLocalBin('/usr/bin:/bin', '/Users/leo'), false);
  assert.equal(pathHasLocalBin('/usr/bin:/Users/leo/.local/bin', '/Users/leo'), true);
  const next = withLocalBinOnPath('');
  assert.match(next, /leocodebox-cli-path/);
  assert.equal(withLocalBinOnPath(next), next);
  assert.match(zprofilePathLine(), /HOME\/\.local\/bin/);
});

test('装机壳接上了终端命令', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:cli-install/);
  assert.match(main, /cwdFromArgv|cliShimBody/);
  assert.match(main, /enqueueOpenCwd/);
});
