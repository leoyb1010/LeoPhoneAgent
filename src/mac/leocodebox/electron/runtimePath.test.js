import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findExecutableInPath,
  getDesktopRuntimePath,
  parseLoginShellEnvironment,
  parseLoginShellPath,
} from './runtimePath.js';

test('parses a login-shell PATH even when shell startup prints other output', () => {
  assert.equal(
    parseLoginShellPath('motd\n__LEOCODEBOX_PATH_START__/custom/bin:/usr/bin__LEOCODEBOX_PATH_END__\n'),
    '/custom/bin:/usr/bin',
  );
});

test('imports only the allowlisted Agent environment from the login shell', () => {
  const output = [
    'startup noise',
    '__LEOCODEBOX_ENV_START__',
    'OPENAI_API_KEY=secret-value\0CODEX_HOME=/custom/codex\0GEMINI_CLI_HOME=/custom/gemini\0PATH=/custom/bin:/usr/bin\0GH_TOKEN=must-not-leak\0',
    '__LEOCODEBOX_ENV_END__',
  ].join('');
  assert.deepEqual(parseLoginShellEnvironment(output), {
    OPENAI_API_KEY: 'secret-value',
    CODEX_HOME: '/custom/codex',
    GEMINI_CLI_HOME: '/custom/gemini',
    PATH: '/custom/bin:/usr/bin',
  });
});

test('desktop PATH includes user agent locations when Finder provides only a system PATH', () => {
  const runtimePath = getDesktopRuntimePath({
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh',
    },
    homeDir: '/Users/tester',
    platform: 'darwin',
    execFileSyncImpl: () => '__LEOCODEBOX_PATH_START__/custom/node/bin:/usr/bin__LEOCODEBOX_PATH_END__',
    readdirSyncImpl: () => [],
  }).split(':');

  assert.equal(runtimePath[0], '/custom/node/bin');
  assert.ok(runtimePath.includes('/Users/tester/.local/bin'));
  assert.ok(runtimePath.includes('/Users/tester/.cursor/bin'));
  assert.ok(runtimePath.includes('/Users/tester/.opencode/bin'));
  assert.ok(runtimePath.includes('/Users/tester/.volta/bin'));
  assert.ok(runtimePath.includes('/Users/tester/Library/pnpm/bin'));
  assert.ok(runtimePath.includes('/Users/tester/.asdf/shims'));
  assert.ok(runtimePath.includes('/opt/homebrew/bin'));
  assert.equal(runtimePath.filter((entry) => entry === '/usr/bin').length, 1);
});

test('explicit agent PATH takes priority over login-shell and fallback paths', () => {
  const runtimePath = getDesktopRuntimePath({
    env: {
      LEOCODEBOX_AGENT_PATH: '/managed/agents',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    },
    homeDir: '/Users/tester',
    platform: 'darwin',
    execFileSyncImpl: () => '__LEOCODEBOX_PATH_START__/shell/bin:/usr/bin__LEOCODEBOX_PATH_END__',
    readdirSyncImpl: () => [],
  }).split(':');

  assert.deepEqual(runtimePath.slice(0, 2), ['/managed/agents', '/shell/bin']);
});

test('a previously captured shell PATH avoids launching a second login shell', () => {
  let executions = 0;
  const runtimePath = getDesktopRuntimePath({
    env: { PATH: '/usr/bin' },
    homeDir: '/Users/tester',
    platform: 'darwin',
    loginShellPath: '/captured/bin:/usr/bin',
    execFileSyncImpl: () => { executions += 1; return ''; },
    readdirSyncImpl: () => [],
  }).split(':');

  assert.equal(executions, 0);
  assert.equal(runtimePath[0], '/captured/bin');
});

test('findExecutableInPath returns the first executable candidate', () => {
  const attempted = [];
  const resolved = findExecutableInPath('claude', '/first:/second', {
    platform: 'darwin',
    accessSyncImpl: (candidate) => {
      attempted.push(candidate);
      if (candidate !== '/second/claude') throw new Error('missing');
    },
  });

  assert.equal(resolved, '/second/claude');
  assert.deepEqual(attempted, ['/first/claude', '/second/claude']);
});
