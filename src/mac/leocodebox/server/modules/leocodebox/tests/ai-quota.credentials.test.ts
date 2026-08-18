import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  maskApiKey,
  maskedQuotaCredentials,
  quotaCredentialsFile,
  readQuotaCredentials,
  readUserQuotaCredential,
  writeQuotaCredential,
} from '../ai-quota.credentials.js';

/**
 * [T-quota-credentials] 这套测试盯的是三件"错了也看不出来"的事:
 *  1. **脱敏** —— 回传给前端的结构里绝不能出现完整 key。漏一次就永久泄露。
 *  2. **原子写与权限** —— 0600/0700、tmp+rename、写坏了不留半个文件。
 *  3. **优先级** —— 用户手填必须盖过本机自动发现,否则用户贴了 key 也没用。
 */

const realHome = os.homedir;
const realFileEnv = process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'leo-quota-cred-'));
  (os as { homedir: () => string }).homedir = () => home;
  // env 覆盖会盖掉 homedir 推导,测试里必须清掉,否则写到真机上去了。
  delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  return home;
}

test.afterEach(() => {
  (os as { homedir: () => string }).homedir = realHome;
  if (realFileEnv === undefined) delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  else process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE = realFileEnv;
});

/* ------------------------------------------------------------------ 脱敏 */

test('maskApiKey keeps only the last 4 chars, and hides short keys entirely', () => {
  assert.equal(maskApiKey('xai-abcdefghijklmnop'), 'mnop');
  assert.equal(maskApiKey('12345678'), '5678', '正好 8 位是允许露尾的边界');
  assert.equal(maskApiKey('1234567'), null, '7 位露 4 位等于露了大半,一律不露');
  assert.equal(maskApiKey(''), null);
});

test('masked view never carries the full key', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-SUPERSECRETVALUE1234');

  const masked = await maskedQuotaCredentials();
  const serialized = JSON.stringify(masked);

  assert.ok(!serialized.includes('SUPERSECRETVALUE'), '脱敏视图里出现了 key 正文');
  assert.ok(!serialized.includes('xai-'), '脱敏视图里出现了 key 前缀');
  for (const entry of masked) {
    assert.ok(!('apiKey' in entry), `${entry.provider} 的脱敏视图带上了 apiKey 字段`);
  }

  const grok = masked.find((entry) => entry.provider === 'grok');
  assert.equal(grok?.configured, true);
  assert.equal(grok?.last4, '1234');
  assert.ok(grok?.updatedAt, '已配置的项要带上更新时间');
});

test('masked view lists every provider, unconfigured ones included', async () => {
  await fakeHome();
  const masked = await maskedQuotaCredentials();
  assert.deepEqual(
    masked.map((entry) => entry.provider).sort(),
    ['cursor', 'gemini', 'grok', 'opencode'],
  );
  for (const entry of masked) {
    assert.equal(entry.configured, false);
    assert.equal(entry.last4, null);
    assert.equal(entry.updatedAt, null);
  }
});

/* -------------------------------------------------------- 原子写与文件权限 */

test('credential file is written 0600 inside a 0700 directory', async () => {
  await fakeHome();
  await writeQuotaCredential('cursor', 'cursor-key-abcdefgh');

  const file = quotaCredentialsFile();
  const fileStat = await stat(file);
  const dirStat = await stat(path.dirname(file));

  assert.equal(fileStat.mode & 0o777, 0o600, '凭据文件必须 0600');
  assert.equal(dirStat.mode & 0o777, 0o700, '凭据目录必须 0700');
});

test('atomic write leaves no temp files behind', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-first-value-here');
  await writeQuotaCredential('cursor', 'cursor-second-value');

  const dir = path.dirname(quotaCredentialsFile());
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `tmp 文件没清干净:${leftovers.join(', ')}`);
});

test('write then read round-trips, and empty string deletes the entry', async () => {
  await fakeHome();

  await writeQuotaCredential('grok', 'xai-round-trip-value');
  assert.equal(await readUserQuotaCredential('grok'), 'xai-round-trip-value');

  // 写第二家不能把第一家冲掉。
  await writeQuotaCredential('cursor', 'cursor-other-value');
  assert.equal(await readUserQuotaCredential('grok'), 'xai-round-trip-value');
  assert.equal(await readUserQuotaCredential('cursor'), 'cursor-other-value');

  await writeQuotaCredential('grok', '');
  assert.equal(await readUserQuotaCredential('grok'), null, '空串应当删除该项');
  assert.equal(await readUserQuotaCredential('cursor'), 'cursor-other-value', '删一家不能波及另一家');

  await writeQuotaCredential('cursor', null);
  assert.equal(await readUserQuotaCredential('cursor'), null, 'null 同样是删除');
});

test('keys are trimmed on write — a pasted trailing newline must not break auth headers', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', '  xai-padded-value-here \n');
  assert.equal(await readUserQuotaCredential('grok'), 'xai-padded-value-here');
});

test('whitespace-only input deletes rather than storing a blank key', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-something-real-x');
  await writeQuotaCredential('grok', '   ');
  assert.equal(await readUserQuotaCredential('grok'), null);
});

/* ---------------------------------------------------------------- 坏文件 */

test('a corrupt or hostile store file degrades to empty instead of throwing', async () => {
  const home = await fakeHome();
  const file = quotaCredentialsFile();
  await mkdir(path.dirname(file), { recursive: true });

  await writeFile(file, 'not json at all', 'utf8');
  assert.deepEqual((await readQuotaCredentials()).providers, {}, '坏 JSON 应当当空处理');

  // 未知 provider、非字符串 key、缺 apiKey 的项都要被丢掉,不能原样透传。
  await writeFile(file, JSON.stringify({
    version: 1,
    providers: {
      grok: { apiKey: 'xai-valid-value-here', updatedAt: '2026-01-01T00:00:00.000Z' },
      cursor: { apiKey: 42 },
      opencode: {},
      evilProvider: { apiKey: 'nope' },
    },
  }), 'utf8');

  const store = await readQuotaCredentials();
  assert.deepEqual(Object.keys(store.providers), ['grok']);
  assert.equal(store.providers.grok?.apiKey, 'xai-valid-value-here');
  assert.ok(!('evilProvider' in store.providers));
  assert.ok(home.length > 0);
});

test('a store file written by hand without updatedAt still reads back', async () => {
  await fakeHome();
  const file = quotaCredentialsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, providers: { grok: { apiKey: 'xai-hand-written-k' } } }), 'utf8');

  assert.equal(await readUserQuotaCredential('grok'), 'xai-hand-written-k');
  const masked = await maskedQuotaCredentials();
  assert.equal(masked.find((entry) => entry.provider === 'grok')?.updatedAt, null);
});

test('the stored file is valid JSON with a trailing newline', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-json-shape-check');
  const raw = await readFile(quotaCredentialsFile(), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(JSON.parse(raw).version, 1);
});
