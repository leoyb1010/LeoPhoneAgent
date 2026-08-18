import http from 'node:http';

/**
 * [T-quota-tray] 菜单栏里的 AI 额度。
 *
 * 参照 CodexBar(steipete/CodexBar)的菜单栏形态:图标旁一个能一眼看懂的计量,
 * 点开是每家 provider 的额度、重置倒计时与接入状态。数据来自本机服务的
 * `/api/leocodebox/quota`(见 server/modules/leocodebox/ai-quota.service.ts),
 * 主进程只负责取数与排版。
 *
 * 两条硬规则:
 *  1. 权威额度与本机估算必须分开标注 —— 把估算值摆成配额是最容易骗到自己的做法。
 *  2. 还没接入的 provider **照样列出来**并写明"未接入",而不是从菜单里消失。
 *     授权是陆续补的,菜单要能告诉你还差谁。
 */

/** 菜单里始终列出的 provider。没数据的显示未接入,不隐藏。 */
export const TRACKED_PROVIDERS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'opencode', label: 'OpenCode' },
];

/** 8 级方块:菜单栏标题里用它画柱状计量,不需要生成位图。 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function blockFor(percent) {
  if (!Number.isFinite(percent) || percent <= 0) return BLOCKS[0];
  const index = Math.min(BLOCKS.length - 1, Math.floor((percent / 100) * BLOCKS.length));
  return BLOCKS[index];
}

export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes >= 10080) return `${Math.round(minutes / 10080)} 周`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} 天`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`;
  return `${minutes} 分钟`;
}

export function resetLabel(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return '';
  const seconds = resetsAt - Math.floor(nowMs / 1000);
  if (seconds <= 0) return '已重置';
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天后重置`;
  if (hours >= 1) return `${hours} 小时后重置`;
  return `${Math.max(1, Math.round(seconds / 60))} 分钟后重置`;
}

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return String(Math.round(value));
}

/**
 * 菜单栏标题:每个有权威额度的 provider 一个方块,后面跟最紧张的那个百分比。
 * 没有任何额度可读时返回空串 —— 菜单栏上不摆一个恒为 0% 的假计量。
 */
export function trayTitle(providers) {
  const authoritative = providers.filter((provider) => provider.authoritative && provider.available);
  if (authoritative.length === 0) return '';
  const worstOf = (provider) => (provider.windows ?? []).reduce(
    (worst, window) => Math.max(worst, window.usedPercent ?? 0),
    0,
  );
  const bars = authoritative.map((provider) => blockFor(worstOf(provider))).join('');
  const worst = Math.max(...authoritative.map(worstOf));
  return `${bars} ${Math.round(worst)}%`;
}

/** 一个 provider 在菜单里的若干行。第一行是它自己,后面缩进的是各时间窗。 */
export function providerMenuLines(provider, nowMs = Date.now()) {
  if (!provider || !provider.available) {
    return [{ label: `${provider?.label ?? '未知'} — 未接入`, enabled: false }];
  }

  const lines = [];
  const plan = provider.plan ? ` · ${provider.plan}` : '';
  const tag = provider.authoritative ? '' : ' · 本机统计';
  lines.push({ label: `${provider.label}${plan}${tag}`, enabled: false });

  for (const window of provider.windows ?? []) {
    const percent = Math.round(window.usedPercent ?? 0);
    const scope = windowLabel(window.windowMinutes);
    const reset = resetLabel(window.resetsAt, nowMs);
    lines.push({
      label: `    ${blockFor(percent)} ${percent}%${scope ? ` · ${scope}窗口` : ''}${reset ? ` · ${reset}` : ''}`,
      enabled: false,
    });
  }

  if (provider.rolling) {
    lines.push({
      label: `    近 ${provider.rolling.windowHours} 小时 · ${formatTokens(provider.rolling.tokens)} tokens · ${provider.rolling.requests} 次`,
      enabled: false,
    });
  }

  if (provider.credits?.hasCredits) {
    lines.push({ label: `    余额 ${provider.credits.balance}`, enabled: false });
  }

  return lines;
}

/** 完整的额度分区(供 buildTrayMenu 拼进模板)。 */
export function quotaMenuSection(snapshot, nowMs = Date.now()) {
  const providers = snapshot?.providers ?? [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const items = [];

  for (const tracked of TRACKED_PROVIDERS) {
    const provider = byId.get(tracked.id) ?? { ...tracked, available: false };
    items.push(...providerMenuLines({ ...tracked, ...provider }, nowMs));
  }

  const today = snapshot?.gateway?.today;
  if (today) {
    items.push({ type: 'separator' });
    items.push({
      label: `Leoapi 今日 · ${formatTokens((today.inputTokens ?? 0) + (today.outputTokens ?? 0))} tokens · ${today.requests ?? 0} 次`,
      enabled: false,
    });
  }

  return items;
}

function requestJson(url, token, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const request = http.get(
      url,
      { headers: token ? { authorization: `Bearer ${token}` } : {}, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/** 取一次额度快照。本地服务没起来就返回 null,菜单保持上一次的内容。 */
export async function fetchQuotaSnapshot(baseUrl, token, force = false) {
  if (!baseUrl) return null;
  const [quota, gateway] = await Promise.all([
    requestJson(`${baseUrl}/api/leocodebox/quota${force ? '?refresh=1' : ''}`, token),
    requestJson(`${baseUrl}/api/leocodebox/gateway/status`, token),
  ]);
  if (!quota?.providers) return null;
  return { providers: quota.providers, gateway: { today: gateway?.meter?.today ?? null } };
}
