import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeQuotaCredential } from '../ai-quota.credentials.js';
import { readGrokSnapshot, type GrokHttp } from '../ai-quota.grok.js';

/**
 * [T-quota-credentials] Grok 探针。三件必须钉死的事:
 *  1. **优先级** —— 用户手填的 key 压过 XAI_API_KEY 环境变量;
 *  2. **不造额度** —— xAI 没有余额接口,所以任何情况下都不许冒出百分比窗口;
 *  3. **封禁的 key 要报错** —— 它照样返回 200,漏判就等于告诉用户"一切正常"。
 */

const realHome = os.homedir;
const realFileEnv = process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
const realXaiKey = process.env.XAI_API_KEY;

async function fakeHome(): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'leo-grok-'));
  (os as { homedir: () => string }).homedir = () => home;
  delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  delete process.env.XAI_API_KEY;
}

test.afterEach(() => {
  (os as { homedir: () => string }).homedir = realHome;
  if (realFileEnv === undefined) delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  else process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE = realFileEnv;
  if (realXaiKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = realXaiKey;
});

const NOW = 1_800_000_000_000;

const OK_PAYLOAD = {
  redacted_api_key: 'xai-...b14o',
  name: 'My API Key',
  team_id: '5ea6f6bd-7815-4b8a-9135-28b2d7ba6722',
  acls: ['api-key:model:*', 'api-key:endpoint:*'],
  api_key_blocked: false,
  api_key_disabled: false,
  team_blocked: false,
};

/** 记录收到的 Authorization,好断言到底送出去的是哪把 key。 */
function spyHttp(payload: unknown, ok = true): { http: GrokHttp; seen: string[] } {
  const seen: string[] = [];
  const http: GrokHttp = async (url, headers) => {
    assert.equal(url, 'https://api.x.ai/v1/api-key', '不许打其他端点');
    seen.push(headers.Authorization ?? '');
    return ok ? { ok: true, data: payload } : { ok: false, message: String(payload) };
  };
  return { http, seen };
}

/* ---------------------------------------------------------------- 未配置 */

test('with no key anywhere it stays unconfigured and says where to get one', async () => {
  await fakeHome();
  const { http, seen } = spyHttp(OK_PAYLOAD);
  const snapshot = await readGrokSnapshot(http, NOW);

  assert.equal(snapshot.status, 'unconfigured');
  assert.equal(snapshot.source, 'none');
  assert.equal(snapshot.updatedAt, null);
  assert.deepEqual(seen, [], '没有 key 就不该发请求');
  assert.match(snapshot.note ?? '', /console\.x\.ai/, 'note 必须写清楚去哪拿 key');
});

/* ---------------------------------------------------------------- 优先级 */

test('a user-entered key wins over the XAI_API_KEY environment variable', async () => {
  await fakeHome();
  process.env.XAI_API_KEY = 'xai-from-environment';
  await writeQuotaCredential('grok', 'xai-typed-by-the-user');

  const { http, seen } = spyHttp(OK_PAYLOAD);
  const snapshot = await readGrokSnapshot(http, NOW);

  assert.deepEqual(seen, ['Bearer xai-typed-by-the-user'], '手填的 key 必须压过环境变量');
  const origin = snapshot.details?.[0]?.rows.find((row) => row.label === '凭据来源');
  assert.equal(origin?.value, '手动填写');
});

test('without a user key it falls back to the environment variable', async () => {
  await fakeHome();
  process.env.XAI_API_KEY = 'xai-from-environment';

  const { http, seen } = spyHttp(OK_PAYLOAD);
  const snapshot = await readGrokSnapshot(http, NOW);

  assert.deepEqual(seen, ['Bearer xai-from-environment']);
  assert.equal(snapshot.status, 'ok');
  const origin = snapshot.details?.[0]?.rows.find((row) => row.label === '凭据来源');
  assert.equal(origin?.value, 'XAI_API_KEY 环境变量');
});

test('clearing the user key falls back to the environment again', async () => {
  await fakeHome();
  process.env.XAI_API_KEY = 'xai-from-environment';
  await writeQuotaCredential('grok', 'xai-typed-by-the-user');
  await writeQuotaCredential('grok', '');

  const { http, seen } = spyHttp(OK_PAYLOAD);
  await readGrokSnapshot(http, NOW);
  assert.deepEqual(seen, ['Bearer xai-from-environment']);
});

/* -------------------------------------------------------------- 正常读取 */

test('a valid key yields an authoritative api snapshot without inventing quota', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-a-perfectly-good-key');

  const { http } = spyHttp(OK_PAYLOAD);
  const snapshot = await readGrokSnapshot(http, NOW);

  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.source, 'api', 'xAI 亲口回的,算权威来源');
  assert.equal(snapshot.updatedAt, NOW);
  assert.equal(snapshot.identity?.organization, OK_PAYLOAD.team_id);

  // 契约的核心一条:xAI 不给余额,就一个窗口都不许造。
  assert.equal(snapshot.primary ?? null, null);
  assert.equal(snapshot.secondary ?? null, null);
  assert.equal(snapshot.credits ?? null, null);
  assert.match(snapshot.note ?? '', /余额/, 'note 要解释为什么没有百分比');

  const rows = snapshot.details?.[0]?.rows ?? [];
  assert.equal(rows.find((row) => row.label === 'Key 名称')?.value, 'My API Key');
  assert.equal(rows.find((row) => row.label === 'Key')?.value, 'xai-...b14o');
});

test('the full key never appears in the snapshot', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-DO-NOT-LEAK-THIS-ONE');

  const { http } = spyHttp(OK_PAYLOAD);
  const snapshot = await readGrokSnapshot(http, NOW);
  assert.ok(!JSON.stringify(snapshot).includes('DO-NOT-LEAK-THIS-ONE'), '快照里出现了完整 key');
});

/* ---------------------------------------------------------------- 坏情况 */

test('a blocked or disabled key is reported as an error, not as healthy', async () => {
  for (const flag of ['api_key_blocked', 'api_key_disabled', 'team_blocked']) {
    await fakeHome();
    await writeQuotaCredential('grok', 'xai-a-blocked-key-here');

    const { http } = spyHttp({ ...OK_PAYLOAD, [flag]: true });
    const snapshot = await readGrokSnapshot(http, NOW);

    assert.equal(snapshot.status, 'error', `${flag}=true 必须报错`);
    assert.match(snapshot.error ?? '', /console\.x\.ai/, '报错要说怎么修');
  }
});

test('a failing request surfaces the http message and stays out of ok', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-an-expired-key-xx');

  const { http } = spyHttp('接口返回 401:本机凭据已失效', false);
  const snapshot = await readGrokSnapshot(http, NOW);

  assert.equal(snapshot.status, 'error');
  assert.match(snapshot.error ?? '', /401/);
  assert.equal(snapshot.primary ?? null, null, '失败时更不许造窗口');
});

test('a non-object response is rejected rather than half-parsed', async () => {
  await fakeHome();
  await writeQuotaCredential('grok', 'xai-weird-response-key');

  const { http } = spyHttp(['not', 'an', 'object']);
  const snapshot = await readGrokSnapshot(http, NOW);
  assert.equal(snapshot.status, 'error');
});
