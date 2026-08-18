import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * 额度采集的核心是"从几十 MB 的日志尾部认出最后一帧 rate_limits",
 * 认错了就会把过期的百分比当成当前额度。这里用真实的 Codex 帧结构固定它。
 */

// service 读的是 ~/.codex 与 ~/.claude,测试里把 HOME 指到临时目录。
const realHome = os.homedir;

async function withFakeHome(build: (home: string) => Promise<void>): Promise<typeof import('../ai-quota.service.js')> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'leo-quota-'));
  await build(home);
  (os as { homedir: () => string }).homedir = () => home;
  // service 在模块加载时就解析出路径,所以要绕过缓存重新导入。
  const module = await import(`../ai-quota.service.js?home=${encodeURIComponent(home)}`);
  return module as typeof import('../ai-quota.service.js');
}

test.after(() => { (os as { homedir: () => string }).homedir = realHome; });

test('codex quota is read from the last rate_limits frame in the newest rollout', async () => {
  const service = await withFakeHome(async (home) => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '18');
    await mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      timestamp: '2026-08-18T01:00:00.000Z',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12, window_minutes: 10080, resets_at: 1 }, plan_type: 'pro' } },
    });
    const fresh = JSON.stringify({
      timestamp: '2026-08-18T02:00:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 73, window_minutes: 10080, resets_at: 1787018811 },
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          plan_type: 'pro',
        },
      },
    });
    // 中间夹一条无关帧,确认扫描是"从尾往前找第一帧 rate_limits",不是取第一条。
    const noise = JSON.stringify({ timestamp: '2026-08-18T02:00:01.000Z', payload: { type: 'agent_message' } });
    await writeFile(path.join(dir, 'rollout-a.jsonl'), [stale, fresh, noise].join('\n') + '\n');
  });

  const [codex] = await service.readAiQuota();
  assert.equal(codex.id, 'codex');
  assert.equal(codex.available, true);
  assert.equal(codex.authoritative, true, 'codex 的额度来自服务端下发,必须标为权威');
  assert.equal(codex.plan, 'pro');
  assert.deepEqual(codex.windows, [
    { name: 'primary', usedPercent: 73, windowMinutes: 10080, resetsAt: 1787018811 },
  ]);
});

test('a machine with no codex logs reports unavailable instead of zero', async () => {
  const service = await withFakeHome(async (home) => {
    await mkdir(path.join(home, '.codex'), { recursive: true });
  });
  const [codex] = await service.readAiQuota();
  // 读不到就说读不到 —— 填 0% 会让人以为额度是满的。
  assert.equal(codex.available, false);
  assert.equal(codex.windows, undefined);
});
