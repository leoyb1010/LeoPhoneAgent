import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderAuth } from './claude-auth.provider.js';

/**
 * Reproduces the real failure: in the packaged GUI app every `claude` spawn
 * fails with EBADF, so neither `--version` nor `auth status` can be read and
 * the check falls back to `.credentials.json` — which newer Claude Code no
 * longer refreshes (the live credential lives in the Keychain). A stale
 * `expiresAt` there must NOT be reported as "logged out".
 */
const ebadf = () => Object.assign(new Error('spawn EBADF'), { code: 'EBADF' });
const allSpawnsFail = async () => ({ error: ebadf(), status: null, stdout: '', stderr: '' });

const HOUR = 60 * 60 * 1000;

async function statusWithCredentials(oauth: Record<string, unknown>, accountEmail?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-auth-'));
  const saved = {
    cfg: process.env.CLAUDE_CONFIG_DIR,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    key: process.env.ANTHROPIC_API_KEY,
  };
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.ANTHROPIC_AUTH_TOKEN; // env creds would short-circuit the file check
  delete process.env.ANTHROPIC_API_KEY;
  try {
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
    if (accountEmail) {
      writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: accountEmail } }), 'utf8');
    }
    return await new ClaudeProviderAuth(allSpawnsFail).getStatus();
  } finally {
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('expired access token WITH a refreshToken still reads as logged in', async () => {
  const status = await statusWithCredentials({
    accessToken: 'stale-access',
    refreshToken: 'refresh-me',
    expiresAt: Date.now() - 5 * HOUR,
  });
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'credentials_file');
  assert.equal(status.installed, true); // EBADF is not "not installed"
  assert.equal(status.version, null); // version unreadable, but it must not gate login
});

test('unexpired access token reads as logged in (unchanged)', async () => {
  const status = await statusWithCredentials({ accessToken: 'fresh', refreshToken: 'r', expiresAt: Date.now() + HOUR });
  assert.equal(status.authenticated, true);
});

test('the account email is shown instead of the "Authenticated" placeholder', async () => {
  const status = await statusWithCredentials(
    { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
    'someone@example.com',
  );
  assert.equal(status.authenticated, true);
  assert.equal(status.email, 'someone@example.com');
});

test('with no known address the email is null, never an English placeholder', async () => {
  const status = await statusWithCredentials({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + HOUR });
  assert.equal(status.authenticated, true);
  // null on purpose: the UI renders its own localized "已登录" label. A string
  // like "Authenticated" here would leak English into a Chinese account tile.
  assert.equal(status.email, null);
});

test('expired access token WITHOUT a refreshToken still reports expired', async () => {
  const status = await statusWithCredentials({ accessToken: 'stale-access', expiresAt: Date.now() - 5 * HOUR });
  assert.equal(status.authenticated, false);
  assert.match(String(status.error), /expired/i);
});
