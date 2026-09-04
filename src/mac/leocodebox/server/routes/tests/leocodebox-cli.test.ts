import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import {
  CLI_TOOLS,
  bundledCodexHostExecutable,
  classifyInstallSource,
  clearCliLatestVersionCache,
  deriveNpmPrefixFromCopyPath,
  detectCliInstallSource,
  discoverCliCopies,
  getCliToolStatus,
  readCliLatestVersion,
  resolveCliUpdateCommand,
  withCliMutation,
  retryOnTransientSpawn,
  default as cliToolsRoutes,
  mergeToolWithLastGood,
  toolLooksTransient,
} from '../../modules/leocodebox/cli-tools.routes.js';
import { compareSemver } from '../../modules/leocodebox/version-network.utils.js';

const opencode = {
  id: 'opencode',
  cmd: 'opencode',
  npmPackage: 'opencode-ai',
  updateArgs: null,
};

test('bundled CodexHost payload is the exact runnable upstream release', async () => {
  const executable = bundledCodexHostExecutable();
  assert.equal((await fs.stat(executable)).isFile(), true);
  const status = await getCliToolStatus(CLI_TOOLS.codexhost, { checkLatest: false });
  assert.equal(status.installed, true);
  assert.equal(status.runnable, true);
  assert.equal(status.currentVersion, '0.4.4');
  assert.equal(status.installSource, 'app-bundled');
  assert.equal(status.canLaunch, true);
});

test('CLI install source detection uses strict known path segments', async () => {
  assert.equal((await detectCliInstallSource(opencode, async () => '/opt/homebrew/Cellar/opencode/1/bin/opencode')).source, 'homebrew');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.npm-global/lib/node_modules/opencode-ai/bin/opencode')).source, 'npm-global');
  assert.equal((await detectCliInstallSource(opencode, async () => '/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode')).source, 'npm-global');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.local/share/cursor-agent/versions/1/cursor-agent')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.opencode/bin/opencode')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.bun/bin/opencode')).source, 'bun');
  assert.equal((await detectCliInstallSource(CLI_TOOLS.grok, async () => '/Users/test/.grok/downloads/grok-0.2.93-macos-aarch64')).source, 'standalone');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/.volta/bin/opencode')).source, 'volta');
  assert.equal((await detectCliInstallSource(opencode, async () => '/Users/test/bin/npm/opencode')).source, 'unknown');
  assert.equal((await detectCliInstallSource(opencode, async () => null)).source, 'unknown');
});

test('copy discovery follows the user login-shell PATH, not the server PATH', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-cli-copies-'));
  const userBin = path.join(scratch, 'user-bin');
  const serverOnlyBin = path.join(scratch, 'server-only-bin');
  await fs.mkdir(userBin);
  await fs.mkdir(serverOnlyBin);
  const script = '#!/bin/sh\necho "9.9.9"\n';
  await fs.writeFile(path.join(userBin, 'fakecli'), script, { mode: 0o755 });
  await fs.writeFile(path.join(serverOnlyBin, 'fakecli'), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });

  const previousLoginPath = process.env.LEOCODEBOX_LOGIN_SHELL_PATH;
  const previousPath = process.env.PATH;
  // Server PATH sees both dirs (server-only first); the user's shell only sees user-bin.
  process.env.PATH = `${serverOnlyBin}:${userBin}:${previousPath}`;
  process.env.LEOCODEBOX_LOGIN_SHELL_PATH = `${userBin}:/usr/bin:/bin`;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousLoginPath === undefined) delete process.env.LEOCODEBOX_LOGIN_SHELL_PATH;
    else process.env.LEOCODEBOX_LOGIN_SHELL_PATH = previousLoginPath;
  });

  const fakeTool = { id: 'fakecli', cmd: 'fakecli', npmPackage: null, updateArgs: null };
  const copies = await discoverCliCopies(fakeTool);
  assert.equal(copies.length, 1, 'server-only copies must not count as references');
  assert.equal(copies[0].path, path.join(userBin, 'fakecli'));
  assert.equal(copies[0].active, true);
  assert.equal(copies[0].version, '9.9.9');

  // A CLI missing from the user's shell PATH falls back to server-wide lookup.
  process.env.LEOCODEBOX_LOGIN_SHELL_PATH = '/usr/bin:/bin';
  const fallback = await discoverCliCopies(fakeTool);
  assert.equal(fallback.length >= 1, true);
  assert.equal(fallback[0].path, path.join(serverOnlyBin, 'fakecli'));
});

test('shadow-copy warning fires only when the ACTIVE copy is the stale one', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-cli-shadow-'));
  const newBin = path.join(scratch, 'new-bin');
  const oldBin = path.join(scratch, 'old-bin');
  await Promise.all([newBin, oldBin].map((dir) => fs.mkdir(dir)));
  // Two genuinely different files → realpath dedup keeps both as copies.
  await fs.writeFile(path.join(newBin, 'shadowcli'), '#!/bin/sh\necho "1.18.2"\n', { mode: 0o755 });
  await fs.writeFile(path.join(oldBin, 'shadowcli'), '#!/bin/sh\necho "1.17.18"\n', { mode: 0o755 });

  const previousLoginPath = process.env.LEOCODEBOX_LOGIN_SHELL_PATH;
  t.after(() => {
    if (previousLoginPath === undefined) delete process.env.LEOCODEBOX_LOGIN_SHELL_PATH;
    else process.env.LEOCODEBOX_LOGIN_SHELL_PATH = previousLoginPath;
  });
  const tool = { id: 'shadowcli', label: 'ShadowCLI', cmd: 'shadowcli', npmPackage: null, updateArgs: null } as never;

  // Active (first in PATH) is the NEWEST → older shadow is harmless → no warning.
  process.env.LEOCODEBOX_LOGIN_SHELL_PATH = `${newBin}:${oldBin}:/usr/bin:/bin`;
  const quiet = await getCliToolStatus(tool, { checkLatest: false });
  assert.equal(quiet.copies.length, 2);
  assert.equal(quiet.currentVersion, '1.18.2');
  assert.equal(quiet.newestCopyVersion, '1.18.2');
  assert.equal(quiet.hasNewerShadowCopy, false, 'running the newest copy must not warn');

  // Active is the OLDER one while a newer copy is shadowed → warn.
  process.env.LEOCODEBOX_LOGIN_SHELL_PATH = `${oldBin}:${newBin}:/usr/bin:/bin`;
  const noisy = await getCliToolStatus(tool, { checkLatest: false });
  assert.equal(noisy.currentVersion, '1.17.18');
  assert.equal(noisy.newestCopyVersion, '1.18.2');
  assert.equal(noisy.hasNewerShadowCopy, true, 'running a stale shadowed copy must warn');
});

test('explicit Agent PATH stays ahead of login-shell and host server copies', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-cli-explicit-'));
  const explicitBin = path.join(scratch, 'explicit-bin');
  const shellBin = path.join(scratch, 'shell-bin');
  const hostBin = path.join(scratch, 'host-bin');
  await Promise.all([explicitBin, shellBin, hostBin].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(explicitBin, 'fakecli'), '#!/bin/sh\necho "9.1.1"\n', { mode: 0o755 });
  await fs.writeFile(path.join(shellBin, 'fakecli'), '#!/bin/sh\necho "8.1.1"\n', { mode: 0o755 });
  await fs.writeFile(path.join(hostBin, 'fakecli'), '#!/bin/sh\necho "2.1.207"\n', { mode: 0o755 });

  const previous = {
    agentPath: process.env.LEOCODEBOX_AGENT_PATH,
    loginPath: process.env.LEOCODEBOX_LOGIN_SHELL_PATH,
    path: process.env.PATH,
  };
  process.env.LEOCODEBOX_AGENT_PATH = explicitBin;
  process.env.LEOCODEBOX_LOGIN_SHELL_PATH = `${shellBin}:/usr/bin:/bin`;
  process.env.PATH = `${hostBin}:${previous.path || ''}`;
  t.after(() => {
    for (const [key, value] of Object.entries({
      LEOCODEBOX_AGENT_PATH: previous.agentPath,
      LEOCODEBOX_LOGIN_SHELL_PATH: previous.loginPath,
      PATH: previous.path,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const copies = await discoverCliCopies({ id: 'fakecli', cmd: 'fakecli', npmPackage: null, updateArgs: null });
  assert.deepEqual(copies.map((copy) => copy.version), ['9.1.1', '8.1.1']);
  assert.equal(copies[0].path, path.join(explicitBin, 'fakecli'));
  assert.equal(copies[0].active, true);
  assert.equal(copies.some((copy) => copy.path.startsWith(hostBin)), false);
});

test('native installer binaries in writable bin dirs are classified standalone', () => {
  // Claude's native installer drops a self-updating binary straight into
  // /opt/homebrew/bin without any brew formula owning it.
  assert.equal(classifyInstallSource('/opt/homebrew/bin/claude'), 'standalone');
  assert.equal(classifyInstallSource('/usr/local/bin/claude'), 'standalone');
  assert.equal(classifyInstallSource('/Users/test/bin/claude'), 'standalone');
  // Package-manager copies still resolve into their real buckets first.
  assert.equal(classifyInstallSource('/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude'), 'npm-global');
  assert.equal(classifyInstallSource('/opt/homebrew/Cellar/foo/1/bin/foo'), 'homebrew');
  assert.equal(classifyInstallSource('/Users/test/bin/npm/opencode'), 'unknown');
});

test('npm prefix derivation pins updates to the copy the user actually runs', () => {
  assert.equal(
    deriveNpmPrefixFromCopyPath('/Users/test/.nvm/versions/node/v22.22.3/lib/node_modules/@anthropic-ai/claude-code/bin/claude'),
    '/Users/test/.nvm/versions/node/v22.22.3',
  );
  assert.equal(
    deriveNpmPrefixFromCopyPath('/Users/test/.local/lib/node_modules/@openai/codex/bin/codex.js'),
    '/Users/test/.local',
  );
  assert.equal(deriveNpmPrefixFromCopyPath('/opt/homebrew/bin/claude'), null);
});

test('update commands target the active copy: npm gets --prefix, standalone runs the exact path', async () => {
  const nvmCopy = {
    path: '/Users/test/.nvm/versions/node/v22.22.3/bin/claude',
    realPath: '/Users/test/.nvm/versions/node/v22.22.3/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    version: '2.1.206',
    source: 'npm-global' as const,
    active: true,
  };
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.claude, 'npm-global', nvmCopy), {
    command: 'npm',
    args: ['install', '--global', '--prefix=/Users/test/.nvm/versions/node/v22.22.3', '@anthropic-ai/claude-code@latest'],
  });

  const nativeCopy = {
    path: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    version: '2.1.206',
    source: 'standalone' as const,
    active: true,
  };
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.claude, 'standalone', nativeCopy), {
    command: '/opt/homebrew/bin/claude',
    args: ['update'],
  });
});

test('all supported standalone agents expose their verified updater', async () => {
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.cursor, 'standalone'), { command: 'cursor-agent', args: ['update'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.opencode, 'standalone'), { command: 'opencode', args: ['upgrade'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.hermes, 'standalone'), { command: 'hermes', args: ['update'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.grok, 'standalone'), { command: 'grok', args: ['update'] });
});

test('Homebrew and Bun update commands preserve the detected installer', async () => {
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.claude, 'homebrew'), { command: 'brew', args: ['upgrade', '--cask', 'claude-code'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.gemini, 'homebrew'), { command: 'brew', args: ['upgrade', 'gemini-cli'] });
  assert.deepEqual(await resolveCliUpdateCommand(CLI_TOOLS.codex, 'bun'), { command: 'bun', args: ['add', '--global', '@openai/codex@latest'] });
});

test('semantic version comparison handles prerelease precedence', () => {
  assert.equal(compareSemver('1.39.0', '1.39.0-beta.2'), 1);
  assert.equal(compareSemver('1.39.0-beta.10', '1.39.0-beta.2'), 8);
  assert.equal(compareSemver('v1.39.0', '1.38.9'), 1);
});

test('unknown CLI sources cannot trigger a shadow global update', async () => {
  assert.equal(await resolveCliUpdateCommand(opencode, 'unknown'), null);
  assert.deepEqual(await resolveCliUpdateCommand(opencode, 'npm-global'), {
    command: 'npm',
    args: ['install', '--global', 'opencode-ai@latest'],
  });
});

test('CLI mutations reject concurrent operations for the same tool', async () => {
  let release: ((value: string) => void) | undefined;
  const blocker = new Promise((resolve) => { release = resolve; });
  const first = withCliMutation('opencode', async () => blocker);
  await assert.rejects(
    withCliMutation('opencode', async () => undefined),
    (error) => error instanceof Error && 'statusCode' in error && error.statusCode === 409,
  );
  const otherTool = withCliMutation('codex', async () => 'ok');
  assert.equal(await otherTool, 'ok');
  release?.('done');
  assert.equal(await first, 'done');
});


test('CLI registry versions are cached for a day and can be force-refreshed', async () => {
  clearCliLatestVersionCache();
  let loads = 0;
  const loadLatest = async () => {
    loads += 1;
    return loads === 1 ? '1.2.3' : '1.2.4';
  };

  const fresh = await readCliLatestVersion(opencode, { now: 1000, loadLatest });
  const cached = await readCliLatestVersion(opencode, { now: 2000, loadLatest });
  const refreshed = await readCliLatestVersion(opencode, { force: true, now: 3000, loadLatest });

  assert.deepEqual(fresh, {
    version: '1.2.3',
    checkedAt: new Date(1000).toISOString(),
    source: 'registry',
  });
  assert.equal(cached.version, '1.2.3');
  assert.equal(cached.source, 'cache');
  assert.equal(refreshed.version, '1.2.4');
  assert.equal(refreshed.source, 'registry');
  assert.equal(loads, 2);
  clearCliLatestVersionCache();
});

test('CLI mutation routes enforce local mode and reject unsafe or unsupported ids', async (t) => {
  const previous = { local: process.env.LEOCODEBOX_LOCAL_ONLY, nodeEnv: process.env.NODE_ENV, home: process.env.LEOCODEBOX_TEST_HOME };
  delete process.env.LEOCODEBOX_LOCAL_ONLY;
  delete process.env.LEOCODEBOX_TEST_HOME;
  process.env.NODE_ENV = 'production';
  const app = express();
  app.use('/cli', cliToolsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    Object.assign(process.env, { LEOCODEBOX_LOCAL_ONLY: previous.local, NODE_ENV: previous.nodeEnv, LEOCODEBOX_TEST_HOME: previous.home });
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) if (previous[key] === undefined) {
      const envKey = { local: 'LEOCODEBOX_LOCAL_ONLY', nodeEnv: 'NODE_ENV', home: 'LEOCODEBOX_TEST_HOME' }[key];
      delete process.env[envKey];
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cli`;
  assert.equal((await fetch(`${base}/codex/update`, { method: 'POST' })).status, 403);

  process.env.LEOCODEBOX_LOCAL_ONLY = '1';
  assert.equal((await fetch(`${base}/__proto__/update`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/cursor/install`, { method: 'POST' })).status, 409);
});

test('transient EBADF results never replace last-good tool state', () => {
  const good = { id: 'claude', installed: true, runnable: true, error: null } as never;
  const ebadf = { id: 'claude', installed: false, runnable: false, error: 'spawn EBADF' } as never;
  const missing = { id: 'claude', installed: false, runnable: false, error: 'claude executable was not found' } as never;
  // EBADF 只能算"未知":有旧好状态时必须保留旧的。
  assert.equal(mergeToolWithLastGood(ebadf, good), good);
  // 真实的"未找到"不是瞬态,必须如实替换。
  assert.equal(mergeToolWithLastGood(missing, good), missing);
  // 没有旧状态时,如实返回(不伪造)。
  assert.equal(mergeToolWithLastGood(ebadf, null), ebadf);
  assert.equal(toolLooksTransient(ebadf as { error?: string | null }), true);
  assert.equal(toolLooksTransient(missing as { error?: string | null }), false);
});

// --- EBADF retry: the bug that made 更新 fail outright -----------------------
// The retry loop used to live INSIDE the branch that also applied the probe
// concurrency gate, so install/update (which skip the gate because they run for
// minutes) skipped the retry too and died on the first `spawn EBADF`. Both
// paths now share retryOnTransientSpawn; these lock its semantics.

const ebadf = () => ({ ok: false as const, code: 'EBADF', stdout: '', stderr: '', error: 'spawn EBADF' });
const fine = () => ({ ok: true as const, code: 0, stdout: 'ok', stderr: '', error: null });
const noSleep = async () => undefined;

test('retryOnTransientSpawn retries an EBADF failure until it succeeds', async () => {
  let calls = 0;
  const result = await retryOnTransientSpawn(async () => {
    calls += 1;
    return calls < 4 ? ebadf() : fine();
  }, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 4);
});

test('retryOnTransientSpawn gives up after the limit and returns the real failure', async () => {
  let calls = 0;
  const result = await retryOnTransientSpawn(async () => { calls += 1; return ebadf(); }, { limit: 3, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /EBADF/);
  assert.equal(calls, 4); // first attempt + 3 retries
});

test('retryOnTransientSpawn does NOT retry an ordinary failure', async () => {
  let calls = 0;
  const result = await retryOnTransientSpawn(async () => {
    calls += 1;
    return { ok: false as const, code: 1, stdout: '', stderr: 'command not found', error: 'Exited with code 1' };
  }, { sleep: noSleep });
  assert.equal(calls, 1); // a genuinely broken CLI must fail fast
  assert.equal(result.ok, false);
});

test('the retry backoff grows so it can outlast an npm-install EBADF window', async () => {
  const waited: number[] = [];
  await retryOnTransientSpawn(async () => ebadf(), {
    limit: 8,
    sleep: async (ms: number) => { waited.push(ms); },
  });
  assert.equal(waited.length, 8);
  assert.deepEqual(waited, [300, 600, 900, 1200, 1500, 1800, 2100, 2400]);
  assert.ok(waited.reduce((a, b) => a + b, 0) >= 10_000); // ~10.8s of cover
});
