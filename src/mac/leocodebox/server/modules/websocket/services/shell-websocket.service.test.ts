import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildShellCommand } from './shell-websocket.service.js';

// 2.0 终端抽屉:plain shell 不带命令时必须起交互 shell,而不是 `bash -c ""` 立刻退出。
const deps = {} as never;

test('plain shell without a command starts the interactive login shell', () => {
  const command = buildShellCommand({ type: 'init', isPlainShell: true }, deps);
  assert.notEqual(command, '');
  assert.match(command, /SHELL|powershell/);
});

test('plain shell with a command runs exactly that command', () => {
  const command = buildShellCommand({ type: 'init', isPlainShell: true, initialCommand: 'ls -la' }, deps);
  assert.equal(command, 'ls -la');
});

test('a bare command without a session is still treated as plain shell', () => {
  const command = buildShellCommand({ type: 'init', initialCommand: 'git status', hasSession: false }, deps);
  assert.equal(command, 'git status');
});
