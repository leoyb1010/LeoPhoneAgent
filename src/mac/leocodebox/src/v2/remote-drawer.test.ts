import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isRemoteDrawerKind, mergeFilePins, remoteDrawerActions, remoteDrawerCopy, remoteFileSubstitute } from './remote-drawer';

test('远程抽屉不假装已经接通终端或文件树', () => {
  const term = remoteDrawerCopy('term', { machineName: 'Fold', cwd: '/data/work' });
  assert.equal(term.title, '远程 · 终端');
  assert.match(term.lead, /接不到/);
  assert.match(term.body, /Fold 的 \/data\/work/);
  assert.doesNotMatch(term.lead + term.body, /已连接|正在代理|已接通/);

  const files = remoteDrawerCopy('files', { machineName: 'Fold', cwd: '' });
  assert.equal(files.title, '远程 · 文件');
  assert.match(files.lead, /打不开/);
  assert.match(files.lead + files.body, /中继读正文|点下面的文件/);
});

test('产物清单补到工具行后面,不重复', () => {
  const listed = mergeFilePins(
    [{ key: '1', file: 'src/a.ts' }],
    [{ name: 'src/a.ts' }, { name: 'notes.md' }, { name: '  ' }],
  );
  assert.deepEqual(listed.map((row) => `${row.file}:${row.state}`), ['src/a.ts:已改', 'notes.md:产物']);
});

test('远程抽屉动作是复制、续写、在那台机器上新开、打开设备', () => {
  assert.deepEqual(remoteDrawerActions({ cwd: '/tmp/x' }), ['copy-cwd', 'continue', 'new-on-machine', 'show-device']);
  assert.deepEqual(remoteDrawerActions({ cwd: '  ' }), ['continue', 'new-on-machine', 'show-device']);
  assert.equal(isRemoteDrawerKind('term'), true);
  assert.equal(isRemoteDrawerKind('diff'), false);
});

test('远程文件抽屉用会话改过的文件当可用替代,不编造目录树', () => {
  const listed = remoteFileSubstitute([
    { key: '1', file: 'src/a.ts' },
    { key: '2', file: 'src/a.ts', running: true },
    { key: '3', file: 'README.md', error: true },
    { key: '4', file: '  ' },
  ]);
  assert.deepEqual(listed.map((row) => `${row.file}:${row.state}`), ['src/a.ts:已改', 'README.md:失败']);
});

test('2.0 壳把远程抽屉接到复制、续写、在那台机器上新开、打开设备', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /remoteDrawerActions/);
  assert.match(app, /newOnMachine/);
  assert.match(app, /showDevice/);
  assert.match(app, /focusMachine/);
  assert.match(app, /artifactError/);
  assert.doesNotMatch(app, /这一侧还接不到远程机器的终端和文件/);
});
