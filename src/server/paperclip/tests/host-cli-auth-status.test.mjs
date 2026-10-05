import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'host-cli-auth-'));
// 1.1.6：状态模块依赖共享的私密变量剔除模块；测试把包路径改指同目录的编译副本。
const privateEnvSource = await fs.readFile(new URL('../native/adapter-utils/server-private-env.ts', import.meta.url), 'utf8');
await fs.writeFile(path.join(directory, 'server-private-env.mjs'), stripTypeScriptTypes(privateEnvSource));
const source = (await fs.readFile(new URL('../native/server/host-cli-auth-status.ts', import.meta.url), 'utf8'))
  .split('"@paperclipai/adapter-utils/server-private-env"').join('"./server-private-env.mjs"');
const compiled = stripTypeScriptTypes(source);
const moduleFile = path.join(directory, 'status.mjs');
await fs.writeFile(moduleFile, compiled);
const { getHostCliAuthStatus, resolveHostCliExecutable, HOST_CLI_AUTH_PROFILES } = await import(pathToFileURL(moduleFile));

async function fixture(t, name, body) {
  const root = await fs.mkdtemp(path.join(directory, 'fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return { PATH: root, HOME: root };
}

test('remote and unsupported adapters never execute a host CLI', async t => {
  const env = await fixture(t, 'codex', 'process.exit(99)');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'sandbox', trustedEnv: env })).authStatus, 'unsupported');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'cursor_cloud', driver: 'local', trustedEnv: env })).authStatus, 'unsupported');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'constructor', driver: 'local', trustedEnv: env })).authStatus, 'unsupported');
});

test('Codex uses only login status and never exposes credential-like output', async t => {
  const env = await fixture(t, 'codex', 'if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["login","status"]))process.exit(99); process.stderr.write("Logged in using ChatGPT\\nsecret-token person@example.com");');
  const status = await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: env });
  assert.equal(status.installed, true);
  assert.equal(status.authStatus, 'present');
  assert.doesNotMatch(JSON.stringify(status), /secret-token|person@example/);
});

test('Codex recognizes signed-out status but not arbitrary failures', async t => {
  const signedOut = await fixture(t, 'codex', 'process.stderr.write("Not logged in");process.exit(1)');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: signedOut })).authStatus, 'absent');
  const failed = await fixture(t, 'codex', 'process.stderr.write("keychain failure secret-token");process.exit(1)');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: failed })).authStatus, 'unknown');
});

test('Claude reads the supported JSON status without reflecting email or tokens', async t => {
  const env = await fixture(t, 'claude', 'if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["auth","status"]))process.exit(99);console.log(JSON.stringify({loggedIn:true,authMethod:"oauth_token",email:"person@example.com",token:"secret-token"}));');
  const status = await getHostCliAuthStatus({ adapterType: 'claude_local', driver: 'local', trustedEnv: env });
  assert.equal(status.authStatus, 'present');
  assert.doesNotMatch(JSON.stringify(status), /secret-token|person@example/);
});

test('Claude signed-out JSON and malformed output remain distinct', async t => {
  const signedOut = await fixture(t, 'claude', 'console.log(JSON.stringify({loggedIn:false}));process.exit(1)');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'claude_local', driver: 'local', trustedEnv: signedOut })).authStatus, 'absent');
  const malformed = await fixture(t, 'claude', 'console.log("loggedIn=true")');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'claude_local', driver: 'local', trustedEnv: malformed })).authStatus, 'unknown');
});

test('Grok credential presence is never treated as verified authentication', async t => {
  const env = await fixture(t, 'grok', 'process.exit(99)');
  await fs.mkdir(path.join(env.HOME, '.grok'));
  await fs.writeFile(path.join(env.HOME, '.grok/auth.json'), 'secret-token');
  const status = await getHostCliAuthStatus({ adapterType: 'grok_local', driver: 'local', trustedEnv: env });
  assert.equal(status.installed, true);
  assert.equal(status.authStatus, 'unknown');
  assert.match(status.message, /凭据文件/);
  assert.doesNotMatch(JSON.stringify(status), /secret-token/);
});

test('other local adapter API keys are presence signals only', async t => {
  const env = await fixture(t, 'gemini', 'process.exit(99)');
  env.GEMINI_API_KEY = 'secret-token';
  const status = await getHostCliAuthStatus({ adapterType: 'gemini_local', driver: 'local', trustedEnv: env });
  assert.equal(status.authStatus, 'unknown');
  assert.match(status.message, /API 凭据/);
  assert.doesNotMatch(JSON.stringify(status), /secret-token/);
  assert.deepEqual(Object.keys(HOST_CLI_AUTH_PROFILES).sort(), ['claude_local','codex_local','cursor','cursor_local','gemini_local','grok_local','hermes_local','kimi_local','opencode_local','pi_local'].sort());
});

test('missing executables and relative PATH entries cannot run arbitrary commands', async () => {
  const status = await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: { PATH: '.', HOME: directory } });
  assert.equal(status.installed, false);
  assert.equal(status.authStatus, 'absent');
});

test('absolute executable resolver shares the fixed trusted PATH profile', async t => {
  const env = await fixture(t, 'codex', 'process.exit(99)');
  assert.equal(await resolveHostCliExecutable('codex_local', env), path.join(env.PATH, 'codex'));
  assert.equal(await resolveHostCliExecutable('constructor', env), null);
});

test('oversized and timed-out CLI output fails closed', async t => {
  const noisy = await fixture(t, 'codex', 'process.stdout.write("x".repeat(65537));setInterval(()=>{},1000)');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: noisy })).authStatus, 'unknown');
  const slow = await fixture(t, 'claude', 'setInterval(()=>{},1000)');
  const started = Date.now();
  assert.equal((await getHostCliAuthStatus({ adapterType: 'claude_local', driver: 'local', trustedEnv: slow })).authStatus, 'unknown');
  assert.ok(Date.now() - started < 6500, 'fixed five-second timeout');
});

test.after(() => fs.rm(directory, { recursive: true, force: true }));

test('Cursor registry type and legacy alias share the fixed CLI profile', () => {
  assert.deepEqual(HOST_CLI_AUTH_PROFILES.cursor, HOST_CLI_AUTH_PROFILES.cursor_local);
});

test('Cursor prefers its branded CLI and rejects a generic Grok agent alias', async t => {
  const grok = await fixture(t, 'agent', 'process.exit(99)');
  const cursor = await fixture(t, 'cursor-agent', 'process.exit(99)');
  const env = { PATH: `${grok.PATH}${path.delimiter}${cursor.PATH}`, HOME: cursor.HOME };
  assert.equal(await resolveHostCliExecutable('cursor', env), path.join(cursor.PATH, 'cursor-agent'));
  assert.equal(await resolveHostCliExecutable('cursor', grok), null);
  const legacy = path.join(cursor.PATH, '.cursor');
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'agent'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(await resolveHostCliExecutable('cursor', { PATH: legacy }), path.join(legacy, 'agent'));
});

// 1.1.6：CLI 子进程不继承服务器私密变量，代理与 CLI 配置保留。
test('host CLI probes do not inherit server database or signing secrets', async t => {
  const env = await fixture(t, 'codex', 'const keys=["DATABASE_URL","BETTER_AUTH_SECRET","PAPERCLIP_TOOL_ACTION_SIGNING_SECRET","PGPASSWORD","PAPERCLIP_SECRETS_MASTER_KEY"];const leaked=keys.filter(k=>process.env[k]!==undefined);if(leaked.length||process.env.HTTPS_PROXY!=="http://127.0.0.1:7890"||process.env.CODEX_HOME!=="/fixture/codex")process.exit(3);process.stderr.write("Logged in using ChatGPT\\n")');
  Object.assign(env, { DATABASE_URL: 'postgres://fixture:secret@127.0.0.1/db', BETTER_AUTH_SECRET: 'auth-secret', PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: 'signing-secret', PGPASSWORD: 'pg-secret', PAPERCLIP_SECRETS_MASTER_KEY: 'master', HTTPS_PROXY: 'http://127.0.0.1:7890', CODEX_HOME: '/fixture/codex' });
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: env })).authStatus, 'present');
});

// 1.1.6：同一服务器环境的并发请求合并为一次探测，10 秒内复用结果。
test('status reads are coalesced and briefly cached per server environment', async t => {
  const env = await fixture(t, 'codex', 'require("node:fs").appendFileSync(process.env.HOME+"/calls","x");process.stderr.write("Not logged in");process.exit(1)');
  const results = await Promise.all([1, 2, 3].map(() => getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: env })));
  assert.deepEqual(results.map(r => r.authStatus), ['absent', 'absent', 'absent']);
  await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: env });
  assert.equal(await fs.readFile(path.join(env.HOME, 'calls'), 'utf8'), 'x');
  assert.equal((await getHostCliAuthStatus({ adapterType: 'codex_local', driver: 'local', trustedEnv: { ...env } })).authStatus, 'absent');
  assert.equal(await fs.readFile(path.join(env.HOME, 'calls'), 'utf8'), 'xx');
});
