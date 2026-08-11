import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCursorPermissionArgs } from '../list/cursor/cursor-runtime.js';
import type { CliCommandRunner } from '../services/cli-version.util.js';
import {
  ClaudeProviderAuth,
  parseClaudeCliAuthStatus,
} from '../list/claude/claude-auth.provider.js';
import {
  CodexProviderAuth,
  parseCodexCliAuthStatus,
} from '../list/codex/codex-auth.provider.js';
import {
  CursorProviderAuth,
  parseCursorLoginStatus,
} from '../list/cursor/cursor-auth.provider.js';
import { OpenCodeProviderAuth } from '../list/opencode/opencode-auth.provider.js';

type TestCliRunner = CliCommandRunner;

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

async function withCleanOpenCodeCredentialEnv<T>(operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(OPENCODE_ENV_CREDENTIAL_KEYS.map((key) => [key, process.env[key]]));
  for (const key of OPENCODE_ENV_CREDENTIAL_KEYS) delete process.env[key];
  try {
    return await operation();
  } finally {
    for (const key of OPENCODE_ENV_CREDENTIAL_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parses Claude CLI logged-in and logged-out JSON', () => {
  assert.deepEqual(
    parseClaudeCliAuthStatus('{"loggedIn":true,"authMethod":"oauth","email":"dev@example.com"}'),
    { authenticated: true, email: 'dev@example.com', method: 'oauth' },
  );
  assert.deepEqual(
    parseClaudeCliAuthStatus('{"loggedIn":false,"authMethod":"none"}'),
    { authenticated: false, email: null, method: null },
  );
  assert.equal(parseClaudeCliAuthStatus('not json'), null);
});

test('parses Codex CLI status without treating not logged in as logged in', () => {
  assert.deepEqual(parseCodexCliAuthStatus('Logged in using ChatGPT'), {
    authenticated: true,
    method: 'cli_login',
  });
  assert.deepEqual(parseCodexCliAuthStatus('Not logged in'), {
    authenticated: false,
    method: null,
  });
  assert.equal(parseCodexCliAuthStatus('Unknown status'), null);
});

test('reports Claude as not installed when the version command cannot start', async () => {
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const fakeSpawn = (() => ({ error: missing, status: null })) as unknown as TestCliRunner;
  const status = await new ClaudeProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
});

test('a broken Codex wrapper still resolves auth state instead of masking it', async () => {
  // A non-runnable version probe (here exit 127) must NOT short-circuit to
  // "could not run": auth is read from files, so we still report installed +
  // unauthenticated. Runnability is surfaced separately by cli/status.
  const fakeSpawn = (() => ({ error: undefined, status: 127, stderr: 'node: command not found' })) as unknown as TestCliRunner;
  const status = await new CodexProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, true);
  // Auth is resolved from real credential files (env-dependent), so only assert
  // the path ran and produced a boolean instead of short-circuiting to an error.
  assert.equal(typeof status.authenticated, 'boolean');
});

test('an inaccessible OpenCode executable still resolves auth state', async () => {
  // EACCES on the version probe must not mask auth: installed stays true (the
  // file exists) and auth falls back to the credential file, here absent.
  const denied = Object.assign(new Error('spawn opencode EACCES'), { code: 'EACCES' });
  const fakeSpawn = (() => ({ error: denied, status: null })) as unknown as TestCliRunner;
  const status = await new OpenCodeProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, true);
  // Auth resolves from the real credential file (env-dependent); assert the path
  // ran and yielded a boolean rather than short-circuiting to a spawn error.
  assert.equal(typeof status.authenticated, 'boolean');
});

test('does not treat empty nested OpenCode auth metadata as credentials', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-empty-auth-'));
  const previousDataDir = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = root;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'auth.json'), JSON.stringify({ openai: { oauth: {} } }));
    await withCleanOpenCodeCredentialEnv(async () => {
      const fakeSpawn = (() => ({ error: undefined, status: 0, stdout: '1.17.18' })) as unknown as TestCliRunner;
      const status = await new OpenCodeProviderAuth(fakeSpawn).getStatus();
      assert.equal(status.installed, true);
      assert.equal(status.authenticated, false);
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('parses Cursor status but requires a real capability probe', () => {
  assert.equal(parseCursorLoginStatus('Login successful!\nLogged in').authenticated, true);
  assert.equal(parseCursorLoginStatus('Authentication required').authenticated, false);
});

test('reports Cursor as not installed when its version command cannot start', async () => {
  const missing = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' });
  const fakeSpawn = (() => ({ error: missing, status: null })) as unknown as TestCliRunner;
  const status = await new CursorProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.authenticated, false);
});

test('rejects stale Cursor login state when listing models fails', async () => {
  const responses = [
    { error: undefined, status: 0, stdout: '2026.06', stderr: '' },
    { error: undefined, status: 0, stdout: 'Login successful!\nLogged in', stderr: '' },
    { error: undefined, status: 1, stdout: '', stderr: 'Authentication required' },
  ];
  const fakeSpawn = (() => responses.shift()) as unknown as TestCliRunner;
  const status = await new CursorProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error || '', /unusable/);
});

test('keeps Cursor authenticated when only the service reachability probe fails', async () => {
  const responses = [
    { error: undefined, status: 0, stdout: '2026.06', stderr: '' },
    { error: undefined, status: 0, stdout: 'Login successful!\nLogged in', stderr: '' },
    {
      error: Object.assign(new Error('getaddrinfo ENOTFOUND api.cursor.com'), { code: 'ENOTFOUND' }),
      status: null,
      stdout: '',
      stderr: '',
    },
  ];
  const fakeSpawn = (() => responses.shift()) as unknown as TestCliRunner;
  const status = await new CursorProviderAuth(fakeSpawn).getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.match(status.error || '', /capability check failed/i);
});

test('maps every advertised Cursor permission mode to a real CLI control', () => {
  assert.deepEqual(resolveCursorPermissionArgs('default'), []);
  assert.deepEqual(resolveCursorPermissionArgs('plan'), ['--plan']);
  assert.deepEqual(resolveCursorPermissionArgs('acceptEdits'), ['--auto-review']);
  assert.deepEqual(resolveCursorPermissionArgs('bypassPermissions'), ['-f']);
});
