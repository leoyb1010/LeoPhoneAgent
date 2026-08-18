import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findGeminiAuthType, readClaudeCredential } from '../ai-quota.credentials.js';
import { computeUsagePace } from '../ai-quota.pace.js';
import { clearAiQuotaCache, readAiQuota, type ProviderSnapshot, type QuotaDeps } from '../ai-quota.service.js';

/**
 * 这套测试盯的是三件最容易悄悄出错、出错了还"看起来正常"的事:
 *  1. 配速的分档与边界 —— 算错了会把"用得正常"报成"严重超支";
 *  2. 占位窗口的标记 —— 漏标就会在 UI 上多出一个幽灵般的 "5h 0%";
 *  3. 读不到时的降级 —— 必须落到 local/unconfigured 并说明,绝不能填 0 冒充额度。
 */

const realHome = os.homedir;
const realCodexHome = process.env.CODEX_HOME;

/** 测试一律不碰真机的钥匙串,也不发真实网络请求。 */
const noKeychain = async (): Promise<string | null> => null;

async function fakeHome(build: (home: string) => Promise<void>): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'leo-quota-'));
  await build(home);
  (os as { homedir: () => string }).homedir = () => home;
  // CODEX_HOME 会盖过 ~/.codex,真机上设了的话测试就读到真目录去了。
  delete process.env.CODEX_HOME;
  clearAiQuotaCache();
  return home;
}

test.afterEach(() => {
  (os as { homedir: () => string }).homedir = realHome;
  if (realCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = realCodexHome;
  clearAiQuotaCache();
});

/** 按 URL 分发的假 fetch。没登记的 URL 直接让测试失败,免得悄悄打真网。 */
function stubFetch(routes: Record<string, { status?: number; body: unknown } | Error>): QuotaDeps['fetchImpl'] {
  return async (url) => {
    const key = Object.keys(routes).find((candidate) => url.startsWith(candidate));
    assert.ok(key, `unexpected request to ${url}`);
    const route = routes[key];
    if (route instanceof Error) throw route;
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(route.body) };
  };
}

const byId = (snapshots: ProviderSnapshot[], id: string): ProviderSnapshot => {
  const found = snapshots.find((snapshot) => snapshot.id === id);
  assert.ok(found, `${id} missing from snapshot list`);
  return found;
};

/* -------------------------------------------------------------- pace 数学 */

test('pace stages walk the |delta| thresholds at 2 / 6 / 12', () => {
  const now = 1_800_000_000_000;
  // 一周窗口正好走了一半:expected = 50%,重置还有 3.5 天。
  const halfway = (usedPercent: number) => ({ usedPercent, windowMinutes: 10080, resetsAt: now + 302_400_000 });
  const stage = (usedPercent: number) => computeUsagePace(halfway(usedPercent), now)?.stage;

  assert.equal(stage(50), 'onTrack');
  assert.equal(stage(52), 'onTrack', '|delta| 恰好 2 仍算持平');
  assert.equal(stage(48), 'onTrack');
  assert.equal(stage(53), 'slightlyAhead');
  assert.equal(stage(56), 'slightlyAhead', '|delta| 恰好 6 仍算轻微');
  assert.equal(stage(44), 'slightlyBehind');
  assert.equal(stage(57), 'ahead');
  assert.equal(stage(62), 'ahead', '|delta| 恰好 12 仍算明显');
  assert.equal(stage(38), 'behind');
  assert.equal(stage(63), 'farAhead');
  assert.equal(stage(37), 'farBehind');
});

test('pace reports eta, speed multiplier and rounded risk', () => {
  const now = 1_800_000_000_000;
  const ahead = computeUsagePace({ usedPercent: 90, windowMinutes: 10080, resetsAt: now + 302_400_000 }, now);
  assert.equal(ahead?.stage, 'farAhead');
  assert.equal(Math.round(ahead?.deltaPercent ?? 0), 40);
  assert.equal(ahead?.willLastToReset, false);
  assert.ok((ahead?.etaSeconds ?? 0) > 0, '超支时要给出预计耗尽时间');
  // 90% 走了一半窗口 → 外推到重置时是 180%,超出 80 个百分点,按 5% 取整。
  assert.equal(ahead?.riskPercent, 80);
  assert.ok((ahead?.speedMultiplier ?? 0) < 1, '撑不到重置时倍数应小于 1');

  const idle = computeUsagePace({ usedPercent: 0, windowMinutes: 10080, resetsAt: now + 302_400_000 }, now);
  assert.equal(idle?.willLastToReset, true);
  assert.equal(idle?.riskPercent, 0);
  // 一点没用 → 速度倍数是无穷大,不编一个数字塞进去。
  assert.equal(idle?.speedMultiplier, null);
});

test('pace declines to guess when the inputs cannot support a conclusion', () => {
  const now = 1_800_000_000_000;
  // 没有重置时间。
  assert.equal(computeUsagePace({ usedPercent: 50, windowMinutes: 10080, resetsAt: null }, now), null);
  // 没有窗口长度。
  assert.equal(computeUsagePace({ usedPercent: 50, windowMinutes: null, resetsAt: now + 1000 }, now), null);
  // 重置时间已经过去。
  assert.equal(computeUsagePace({ usedPercent: 50, windowMinutes: 10080, resetsAt: now - 1 }, now), null);
  // 距离重置比整个窗口还长 —— resetsAt 与 windowMinutes 对不上,算出来的 expected 是错的。
  assert.equal(computeUsagePace({ usedPercent: 50, windowMinutes: 300, resetsAt: now + 300 * 60_000 + 1 }, now), null);
  // 窗口刚开(expected < 3%),分母太小,任何用量都会被放大成"严重超支"。
  assert.equal(computeUsagePace({ usedPercent: 5, windowMinutes: 10080, resetsAt: now + 600_000_000 }, now), null);
  // 占位窗口没有真实用量。
  assert.equal(
    computeUsagePace(
      { usedPercent: 0, windowMinutes: 300, resetsAt: now + 60_000, isSyntheticPlaceholder: true },
      now,
    ),
    null,
  );
});

/* ------------------------------------------------------------------ Codex */

const CODEX_USAGE = {
  email: 'someone@example.com',
  plan_type: 'pro',
  rate_limit: {
    // 本机实测:这个账号的 primary 就是 7 天窗,不是 5 小时窗。
    primary_window: { used_percent: 33, limit_window_seconds: 604_800, reset_at: 1_787_204_065 },
    secondary_window: null,
  },
  additional_rate_limits: [{
    limit_name: 'GPT-5.3-Codex-Spark',
    metered_feature: 'codex_bengalfox',
    rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_at: 1_787_632_424 } },
  }],
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reset_credits: { available_count: 0 },
};

test('codex window length always comes from limit_window_seconds, never from lane position', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'stub' } }));
  });

  const snapshots = await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({ 'https://chatgpt.com': { body: CODEX_USAGE } }),
  });
  const codex = byId(snapshots, 'codex');

  assert.equal(codex.status, 'ok');
  assert.equal(codex.source, 'oauth', '官方接口拿到的额度必须标成权威来源');
  assert.equal(codex.primary?.usedPercent, 33);
  // 604800s / 60 = 10080 分钟 = 7 天。按"primary 就是 5 小时窗"硬编码会标成 300。
  assert.equal(codex.primary?.windowMinutes, 10080);
  assert.equal(codex.primary?.resetsAt, 1_787_204_065_000, 'reset_at 是 epoch 秒,契约要毫秒');
  assert.equal(codex.secondary, null);
  assert.equal(codex.identity?.accountEmail, 'someone@example.com');
  assert.equal(codex.identity?.plan, 'pro');
  assert.deepEqual(codex.extraRateWindows?.map((entry) => entry.title), ['GPT-5.3-Codex-Spark']);
  assert.equal(codex.extraRateWindows?.[0].window.windowMinutes, 10080);
});

test('codex falls back to the local rollout log when the API fails, and says so', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'stub' } }));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '18');
    await mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      timestamp: '2026-08-18T01:00:00.000Z',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12, window_minutes: 10080, resets_at: 1 } } },
    });
    const fresh = JSON.stringify({
      timestamp: '2026-08-18T02:00:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 73, window_minutes: 10080, resets_at: 1_787_018_811 }, plan_type: 'pro' },
      },
    });
    // 中间夹一条无关帧,确认扫描是"从尾往前找第一帧 rate_limits",不是取第一条。
    const noise = JSON.stringify({ timestamp: '2026-08-18T02:00:01.000Z', payload: { type: 'agent_message' } });
    await writeFile(path.join(dir, 'rollout-a.jsonl'), [stale, fresh, noise].join('\n') + '\n');
  });

  const snapshots = await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({ 'https://chatgpt.com': { status: 500, body: {} } }),
  });
  const codex = byId(snapshots, 'codex');

  assert.equal(codex.status, 'ok');
  // 关键:兜底出来的数字必须标成 local,UI 才会写"本机统计"而不是当权威额度。
  assert.equal(codex.source, 'local');
  assert.equal(codex.primary?.usedPercent, 73, '要取最后一帧,不是第一帧');
  assert.equal(codex.primary?.resetsAt, 1_787_018_811_000);
  assert.match(codex.note ?? '', /接口返回 500/);
  assert.match(codex.note ?? '', /本机日志/);
});

test('codex with neither credentials nor logs is unconfigured, not zero', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
  });

  const codex = byId(await readAiQuota({ keychainReader: noKeychain, fetchImpl: stubFetch({}) }), 'codex');
  // 读不到就说读不到 —— 填 0% 会让人以为额度是满的。
  assert.equal(codex.status, 'unconfigured');
  assert.equal(codex.source, 'none');
  assert.equal(codex.primary, undefined);
  assert.equal(codex.updatedAt, null);
  assert.match(codex.note ?? '', /codex login/);
});

/* ----------------------------------------------------------------- Claude */

const claudeUsage = (overrides: Record<string, unknown> = {}) => ({
  five_hour: { utilization: 27, resets_at: '2026-08-18T06:50:00.371827+00:00' },
  seven_day: { utilization: 23, resets_at: '2026-08-23T02:00:00.371848+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  // Anthropic 内部代号窗口:utilization 有值但没有 resets_at。
  nimbus_quill: { utilization: 0, resets_at: null },
  tangelo: null,
  extra_usage: { is_enabled: false, utilization: null },
  ...overrides,
});

async function claudeHome(credential: Record<string, unknown>): Promise<void> {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: credential }));
  });
}

const validCredential = { accessToken: 'stub', expiresAt: Date.now() + 3600_000 };

test('claude maps five_hour and seven_day, and drops internal codename windows', async () => {
  await claudeHome(validCredential);

  const claude = byId(await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({
      'https://api.anthropic.com/api/oauth/usage': { body: claudeUsage() },
      'https://api.anthropic.com/api/oauth/profile': { body: { account: { email: 'me@example.com' }, organization: { organization_type: 'claude_max' } } },
    }),
  }), 'claude');

  assert.equal(claude.status, 'ok');
  assert.equal(claude.source, 'oauth');
  assert.equal(claude.primary?.usedPercent, 27);
  assert.equal(claude.primary?.windowMinutes, 300);
  assert.equal(claude.primary?.isSyntheticPlaceholder, undefined, '真窗口不该被标成占位');
  assert.equal(claude.secondary?.usedPercent, 23);
  assert.equal(claude.secondary?.windowMinutes, 10080);
  // nimbus_quill 有 utilization 但没有 resets_at → 不是真实窗口,不许进 UI。
  assert.deepEqual(claude.extraRateWindows, []);
  assert.equal(claude.identity?.accountEmail, 'me@example.com');
  assert.equal(claude.identity?.plan, 'claude_max');
});

test('a missing five_hour becomes an explicitly flagged placeholder, never a real 0%', async () => {
  await claudeHome(validCredential);

  const claude = byId(await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({
      'https://api.anthropic.com/api/oauth/usage': { body: claudeUsage({ five_hour: null }) },
      'https://api.anthropic.com/api/oauth/profile': { status: 404, body: {} },
    }),
  }), 'claude');

  // 不标 placeholder 的话,UI 上就会出现一个幽灵般的 "5h 0%",看着像额度全新。
  assert.equal(claude.primary?.isSyntheticPlaceholder, true);
  assert.equal(claude.primary?.usedPercent, 0);
  assert.equal(claude.primary?.resetsAt, null);
  assert.match(claude.note ?? '', /占位/);
  // 身份接口挂掉不能拖垮额度本身。
  assert.equal(claude.status, 'ok');
  assert.equal(claude.secondary?.usedPercent, 23);
});

test('a model-scoped weekly window lands in tertiary', async () => {
  await claudeHome(validCredential);

  const claude = byId(await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({
      'https://api.anthropic.com/api/oauth/usage': {
        body: claudeUsage({
          seven_day_opus: { utilization: 8, resets_at: '2026-08-23T02:00:00.372047+00:00' },
          seven_day_sonnet: { utilization: 4, resets_at: '2026-08-23T02:00:00.372047+00:00' },
        }),
      },
      'https://api.anthropic.com/api/oauth/profile': { status: 404, body: {} },
    }),
  }), 'claude');

  assert.equal(claude.tertiary?.usedPercent, 8);
  assert.deepEqual(claude.extraRateWindows?.map((entry) => entry.title), ['Sonnet']);
});

test('claude falls back to the local token tally, which carries no fabricated percentages', async () => {
  await fakeHome(async (home) => {
    const dir = path.join(home, '.claude', 'projects', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: validCredential }));
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-4', usage: { input_tokens: 1000, output_tokens: 500 } },
    });
    await writeFile(path.join(dir, 'session.jsonl'), `${line}\n`);
  });

  const claude = byId(await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({ 'https://api.anthropic.com': new Error('socket hang up') }),
  }), 'claude');

  assert.equal(claude.status, 'ok');
  assert.equal(claude.source, 'local');
  // 本机日志里没有配额窗口,所以一个窗口都不能给 —— 编一个百分比才是最糟的。
  assert.equal(claude.primary, undefined);
  assert.equal(claude.secondary, undefined);
  assert.match(claude.note ?? '', /不是官方配额/);
  assert.match(JSON.stringify(claude.details), /1500 tokens/);
});

test('claude with no usable credential is unconfigured and names what is missing', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
  });

  const claude = byId(await readAiQuota({ keychainReader: noKeychain, fetchImpl: stubFetch({}) }), 'claude');
  assert.equal(claude.status, 'unconfigured');
  assert.equal(claude.source, 'none');
  assert.equal(claude.updatedAt, null);
  assert.match(claude.note ?? '', /没找到 Claude Code 的登录态/);
});

test('an expired credential is reported as expired rather than silently retried into a 401', async () => {
  await claudeHome({ accessToken: 'stub', expiresAt: Date.now() - 3600_000 });

  const claude = byId(await readAiQuota({ keychainReader: noKeychain, fetchImpl: stubFetch({}) }), 'claude');
  assert.equal(claude.status, 'unconfigured');
  assert.match(claude.note ?? '', /已过期/);
});

/* ------------------------------------------------------ 凭据源优先级与形状 */

test('keychain wins over the credentials file, and expired sources are skipped', async () => {
  const now = Date.now();
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'from-file', expiresAt: now + 3600_000 } }),
    );
  });

  // 两边都新鲜:钥匙串优先。
  const fresh = await readClaudeCredential(now, async () =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain', expiresAt: now + 3600_000 } }));
  assert.equal(fresh.credential?.origin, 'keychain');
  assert.equal(fresh.credential?.accessToken, 'from-keychain');

  // 钥匙串过期:跳过它,换文件,并记下"是过期而不是没有"。
  const stale = await readClaudeCredential(now, async () =>
    JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain', expiresAt: now - 1 } }));
  assert.equal(stale.credential?.origin, 'file');
  assert.deepEqual(stale.expiredOrigins, ['keychain']);
});

test('a keychain blob without the claudeAiOauth wrapper still parses', async () => {
  const now = Date.now();
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
  });
  const lookup = await readClaudeCredential(now, async () =>
    JSON.stringify({ accessToken: 'bare', expiresAt: now + 1000 }));
  assert.equal(lookup.credential?.accessToken, 'bare');
});

test('gemini authType is found wherever the CLI version nested it', () => {
  assert.equal(findGeminiAuthType({ selectedAuthType: 'oauth-personal' }), 'oauth-personal');
  assert.equal(findGeminiAuthType({ security: { auth: { selectedType: 'gemini-api-key' } } }), 'gemini-api-key');
  assert.equal(findGeminiAuthType({ nothing: { here: 1 } }), null);
});

/* --------------------------------------------------------------- 清单完整性 */

test('providers with no data source are still listed, each naming what it needs', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
  });

  const snapshots = await readAiQuota({ keychainReader: noKeychain, fetchImpl: stubFetch({}) });
  // 授权是陆续补的,清单要能回答"还差谁"。
  for (const id of ['codex', 'claude', 'gemini', 'cursor', 'grok', 'opencode']) {
    const snapshot = byId(snapshots, id);
    assert.ok(snapshot.accentColor.startsWith('#'), `${id} 缺品牌色`);
    if (snapshot.status !== 'unconfigured') continue;
    assert.ok((snapshot.note ?? '').length > 10, `${id} 的 note 要说清楚缺什么`);
  }
});

test('one provider blowing up does not take the others down', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'stub' } }));
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: validCredential }));
  });

  const snapshots = await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({
      'https://chatgpt.com': new Error('ECONNREFUSED'),
      'https://api.anthropic.com/api/oauth/usage': { body: claudeUsage() },
      'https://api.anthropic.com/api/oauth/profile': { status: 500, body: {} },
    }),
  });

  assert.equal(byId(snapshots, 'codex').status, 'error');
  assert.match(byId(snapshots, 'codex').error ?? '', /ECONNREFUSED/);
  assert.equal(byId(snapshots, 'claude').status, 'ok');
  assert.equal(byId(snapshots, 'claude').primary?.usedPercent, 27);
});

test('no snapshot ever leaks the access token', async () => {
  await fakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'sk-super-secret' } }));
  });

  const snapshots = await readAiQuota({
    keychainReader: noKeychain,
    fetchImpl: stubFetch({ 'https://chatgpt.com': { status: 401, body: {} } }),
  });
  assert.ok(!JSON.stringify(snapshots).includes('sk-super-secret'), 'token 不许出现在快照里');
});
