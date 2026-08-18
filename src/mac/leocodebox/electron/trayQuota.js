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
 *     判据是 snapshot 的 `source`:oauth/api/web/cli 才是服务端下发的额度,
 *     local 一律加"本机统计"后缀。
 *  2. 还没接入的 provider **照样列出来**并写明缺什么,而不是从菜单里消失。
 *     授权是陆续补的,菜单要能告诉你还差谁。
 */

/** 服务端下发的额度来源。local 是本机日志估算,不算数。 */
const AUTHORITATIVE_SOURCES = new Set(['oauth', 'api', 'web', 'cli']);

export const isAuthoritative = (provider) =>
  provider?.status === 'ok' && AUTHORITATIVE_SOURCES.has(provider?.source);

/**
 * 一个 provider 身上所有能显示的窗口。
 * 占位窗口(isSyntheticPlaceholder)必须滤掉 —— 它的 0% 不是"没用",是"没数据"。
 */
export function displayWindows(provider) {
  const named = (provider?.extraRateWindows ?? []).map((entry) => entry?.window);
  return [provider?.primary, provider?.secondary, provider?.tertiary, ...named]
    .filter((window) => window && !window.isSyntheticPlaceholder && Number.isFinite(window.usedPercent));
}

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

/** resetsAt 是 epoch **毫秒**(契约见 server/modules/leocodebox/ai-quota.types.ts)。 */
export function resetLabel(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return '';
  const seconds = Math.floor((resetsAt - nowMs) / 1000);
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
  const authoritative = (providers ?? []).filter(isAuthoritative)
    .map((provider) => displayWindows(provider))
    .filter((windows) => windows.length > 0);
  if (authoritative.length === 0) return '';
  const worstOf = (windows) => windows.reduce((worst, window) => Math.max(worst, window.usedPercent), 0);
  const bars = authoritative.map((windows) => blockFor(worstOf(windows))).join('');
  const worst = Math.max(...authoritative.map(worstOf));
  return `${bars} ${Math.round(worst)}%`;
}

/** 一个 provider 在菜单里的若干行。第一行是它自己,后面缩进的是各时间窗。 */
export function providerMenuLines(provider, nowMs = Date.now()) {
  const label = provider?.label ?? '未知';
  if (!provider || provider.status !== 'ok') {
    // 缺什么要说清楚 —— 光写"未接入"等于没说。
    const why = provider?.note || provider?.error;
    return [{ label: `${label} — 未接入${why ? ` · ${why}` : ''}`, enabled: false }];
  }

  const lines = [];
  const plan = provider.identity?.plan ? ` · ${provider.identity.plan}` : '';
  const tag = isAuthoritative(provider) ? '' : ' · 本机统计';
  lines.push({ label: `${label}${plan}${tag}`, enabled: false });

  for (const window of displayWindows(provider)) {
    const percent = Math.round(window.usedPercent);
    const scope = windowLabel(window.windowMinutes);
    const reset = resetLabel(window.resetsAt, nowMs);
    lines.push({
      label: `    ${blockFor(percent)} ${percent}%${scope ? ` · ${scope}窗口` : ''}${reset ? ` · ${reset}` : ''}`,
      enabled: false,
    });
  }

  // 本机统计这类没有窗口的快照,靠 details 把话说明白。
  for (const section of provider.details ?? []) {
    for (const row of section.rows ?? []) {
      if (section.title !== '本机统计') continue;
      lines.push({ label: `    ${row.label} · ${row.value}${row.secondaryValue ? ` · ${row.secondaryValue}` : ''}`, enabled: false });
    }
  }

  const remaining = provider.credits?.remaining;
  if (Number.isFinite(remaining) && remaining > 0) {
    lines.push({ label: `    余额 ${formatTokens(remaining)} ${provider.credits.unit ?? ''}`.trimEnd(), enabled: false });
  }

  return lines;
}

/** 完整的额度分区(供 buildTrayMenu 拼进模板)。 */
export function quotaMenuSection(snapshot, nowMs = Date.now()) {
  const providers = snapshot?.providers ?? [];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const items = [];

  for (const tracked of TRACKED_PROVIDERS) {
    const provider = byId.get(tracked.id) ?? { ...tracked, status: 'unconfigured' };
    items.push(...providerMenuLines({ ...tracked, ...provider, label: tracked.label }, nowMs));
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
