import { createReadStream, promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

import {
  codexHome,
  type KeychainReader,
  readClaudeCredential,
  readCodexCredential,
  readGeminiAuthType,
  readGeminiCredential,
} from './ai-quota.credentials.js';
import { readGrokSnapshot } from './ai-quota.grok.js';
import { computeUsagePace } from './ai-quota.pace.js';
import {
  accentFor,
  type NamedRateWindow,
  type ProviderCredits,
  type ProviderDetailRow,
  type ProviderDetailSection,
  type ProviderSnapshot,
  type RateWindow,
} from './ai-quota.types.js';

/**
 * [T-quota-bar] 本机 AI 额度采集。
 *
 * 做法吸收自 CodexBar(steipete/CodexBar,MIT,见 NOTICE):**主动拿本机已有的
 * 凭据去调各家官方接口**,而不是被动等日志里偶然掉下来一帧配额。日志那条路
 * 保留下来当兜底 —— 但兜底出来的东西会明确标成 `source: 'local'`,UI 据此写
 * "本机统计",不许当权威额度用。
 *
 * 全局纪律(这版最重要的一条):
 *   **读不到就说读不到。** status = 'error' / 'unconfigured' + 说明,
 *   绝不填 0、绝不造百分比。一个假的"额度还很满"比一片空白危险得多。
 *
 * 另外:token 只在 ai-quota.credentials.ts 与本文件的请求头里流转,
 * 不进日志、不进 error 字段、不进 snapshot。
 */

export { computeUsagePace } from './ai-quota.pace.js';
export * from './ai-quota.types.js';

const CACHE_MS = 60_000;
const NETWORK_TIMEOUT_MS = 10_000;

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/** 只读文件尾部:会话日志能到几十 MB,配额信息总在最后几条。 */
const TAIL_BYTES = 512 * 1024;
/** Claude 本机兜底的滚动窗口,对齐官方 5 小时计费窗便于对照。 */
const CLAUDE_WINDOW_HOURS = 5;

const claudeProjectsDir = (): string => path.join(os.homedir(), '.claude', 'projects');
const codexSessionsDir = (): string => path.join(codexHome(), 'sessions');

/* ------------------------------------------------------------------- HTTP */

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type QuotaDeps = {
  fetchImpl?: FetchLike;
  nowMs?: number;
  /** 测试用的钥匙串桩:不注入的话测试会读到真机上的真凭据。 */
  keychainReader?: KeychainReader;
};

let proxyAgent: EnvHttpProxyAgent | undefined;

/**
 * 本机常年挂着代理(Clash 之类),Node 的 fetch 默认**不认** HTTP_PROXY,
 * 直连 chatgpt.com / api.anthropic.com 就会莫名其妙超时。这里沿用
 * version-network.utils.ts 已经验证过的 EnvHttpProxyAgent 走法。
 */
const defaultFetch: FetchLike = (url, init) => {
  const proxied = Boolean(
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
    || process.env.https_proxy || process.env.http_proxy || process.env.all_proxy,
  );
  if (proxied && !proxyAgent) proxyAgent = new EnvHttpProxyAgent();
  return undiciFetch(url, { ...init, dispatcher: proxied ? proxyAgent : undefined }) as unknown as ReturnType<FetchLike>;
};

type HttpResult = { ok: true; data: unknown } | { ok: false; message: string };

/** 失败信息里只有状态码和人话 —— token 一个字符都不许出现在这里。 */
export async function requestJson(
  url: string,
  headers: Record<string, string>,
  deps: QuotaDeps,
  init?: { method?: string; body?: string },
): Promise<HttpResult> {
  const call = deps.fetchImpl ?? defaultFetch;
  try {
    const response = await call(url, {
      ...init,
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `接口返回 ${response.status}:本机凭据已失效,重新登录该 CLI 后再试` };
      }
      return { ok: false, message: `接口返回 ${response.status}` };
    }
    try {
      return { ok: true, data: JSON.parse(body) as unknown };
    } catch {
      return { ok: false, message: '接口返回的不是 JSON,无法解析额度' };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `请求失败:${reason}` };
  }
}

/* ------------------------------------------------------------- 本机日志兜底 */

async function readTail(filePath: string, bytes = TAIL_BYTES): Promise<string[]> {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - bytes);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start });
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}

/** 递归收集某目录下最近改动过的日志文件(按 mtime 倒序)。 */
async function recentLogs(root: string, suffix: string, sinceMs: number, limit: number): Promise<string[]> {
  const found: { file: string; mtimeMs: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full, depth + 1);
      if (!entry.name.endsWith(suffix)) return;
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs >= sinceMs) found.push({ file: full, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件在遍历途中消失(会话轮转)—— 跳过即可。
      }
    }));
  };
  await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((item) => item.file);
}

/* ------------------------------------------------------------------ 工具 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number | null = null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const stringOr = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** 给窗口挂上配速。pace 不进契约字段,但 details 里要能看到结论。 */
function paceRow(label: string, window: RateWindow | null | undefined, nowMs: number): ProviderDetailRow | null {
  if (!window) return null;
  const pace = computeUsagePace(window, nowMs);
  if (!pace) return null;
  // 给用户看的行,不能漏内部枚举("farBehind")和自造单位("-38.8pt")。
  // 口径与面板上的 pace 文案保持一致:超用 = 烧得比时间快,省下 = 还有余量。
  const delta = Math.round(Math.abs(pace.deltaPercent));
  const head = pace.stage === 'onTrack' || delta === 0
    ? '按节奏'
    : (pace.deltaPercent > 0 ? `超用 ${delta}%` : `省下 ${delta}%`);
  const tail = pace.willLastToReset
    ? '够用到重置'
    : pace.etaSeconds === null ? '' : `约 ${Math.max(1, Math.round(pace.etaSeconds / 3600))} 小时后用光`;
  return {
    label,
    value: head,
    secondaryValue: tail || null,
  };
}

const section = (title: string, rows: (ProviderDetailRow | null)[]): ProviderDetailSection | null => {
  const kept = rows.filter((row): row is ProviderDetailRow => Boolean(row));
  return kept.length > 0 ? { title, rows: kept } : null;
};

const sections = (...items: (ProviderDetailSection | null)[]): ProviderDetailSection[] =>
  items.filter((item): item is ProviderDetailSection => Boolean(item));

const base = (id: string, label: string): ProviderSnapshot => ({
  id,
  label,
  accentColor: accentFor(id),
  status: 'unconfigured',
  source: 'none',
  updatedAt: null,
});

/* ------------------------------------------------------------------ Codex */

type CodexRawWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
};

/**
 * 窗口长度**一律**从 `limit_window_seconds` 算,不按 primary/secondary 的位置猜。
 * 本机实测这个账号的 primary 就是 7 天窗而不是 5 小时窗 —— 按位置硬编码会直接标错。
 */
function codexWindow(raw: unknown, nowMs: number): RateWindow | null {
  if (!isRecord(raw)) return null;
  const window = raw as CodexRawWindow;
  const used = numberOr(window.used_percent);
  if (used === null) return null;
  const seconds = numberOr(window.limit_window_seconds);
  const resetAt = numberOr(window.reset_at);
  const resetAfter = numberOr(window.reset_after_seconds);
  return {
    usedPercent: used,
    windowMinutes: seconds !== null && seconds > 0 ? seconds / 60 : null,
    // reset_at 是 epoch **秒**;没有它就用 reset_after_seconds 推。
    resetsAt: resetAt !== null ? resetAt * 1000 : resetAfter !== null ? nowMs + resetAfter * 1000 : null,
  };
}

function codexExtras(payload: Record<string, unknown>, nowMs: number): NamedRateWindow[] {
  const extras: NamedRateWindow[] = [];
  const push = (id: string, title: string, raw: unknown): void => {
    const window = codexWindow(raw, nowMs);
    if (window) extras.push({ id, title, window, usageKnown: true });
  };

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const entry of additional) {
    if (!isRecord(entry)) continue;
    const title = stringOr(entry.limit_name) ?? stringOr(entry.metered_feature) ?? '附加额度';
    const id = stringOr(entry.metered_feature) ?? title;
    const limit = isRecord(entry.rate_limit) ? entry.rate_limit : null;
    if (!limit) continue;
    push(id, title, limit.primary_window);
    push(`${id}:secondary`, `${title}(次窗口)`, limit.secondary_window);
  }

  const codeReview = isRecord(payload.code_review_rate_limit) ? payload.code_review_rate_limit : null;
  if (codeReview) push('code_review', 'Code Review', codeReview.primary_window);

  return extras;
}

function codexCredits(payload: Record<string, unknown>): ProviderCredits | null {
  const raw = isRecord(payload.credits) ? payload.credits : null;
  if (!raw) return null;
  const balance = Number(raw.balance);
  return {
    remaining: Number.isFinite(balance) ? balance : null,
    total: null,
    unit: 'credits',
    hint: raw.unlimited === true ? '不限量' : raw.has_credits === true ? null : '未购买额外积分',
  };
}

function codexSnapshotFromApi(payload: Record<string, unknown>, nowMs: number): ProviderSnapshot {
  const limit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const primary = codexWindow(limit.primary_window, nowMs);
  const secondary = codexWindow(limit.secondary_window, nowMs);
  const resetCredits = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : null;

  return {
    ...base('codex', 'Codex'),
    status: 'ok',
    source: 'oauth',
    identity: {
      accountEmail: stringOr(payload.email),
      plan: stringOr(payload.plan_type),
      organization: null,
    },
    primary,
    secondary,
    extraRateWindows: codexExtras(payload, nowMs),
    credits: codexCredits(payload),
    details: sections(
      section('账户', [
        stringOr(payload.email) ? { label: '账号', value: stringOr(payload.email) as string } : null,
        stringOr(payload.plan_type) ? { label: '套餐', value: stringOr(payload.plan_type) as string } : null,
        resetCredits && numberOr(resetCredits.available_count) !== null
          ? { label: '重置券', value: String(numberOr(resetCredits.available_count)) }
          : null,
      ]),
      section('配速', [
        paceRow('主窗口', primary, nowMs),
        paceRow('次窗口', secondary, nowMs),
      ]),
    ),
    updatedAt: nowMs,
  };
}

type CodexLogLimits = {
  primary?: unknown;
  secondary?: unknown;
  plan_type?: unknown;
};

/** 兜底:从最近的 rollout 日志尾部捞最后一帧 rate_limits。可能已经是几小时前的。 */
async function codexSnapshotFromLogs(nowMs: number): Promise<ProviderSnapshot | null> {
  const files = await recentLogs(codexSessionsDir(), '.jsonl', nowMs - 3 * 24 * 3600_000, 5);
  for (const file of files) {
    let lines: string[];
    try {
      lines = await readTail(file);
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"rate_limits"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[index]) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = isRecord(entry.payload) ? entry.payload : entry;
      const limits = isRecord(payload.rate_limits) ? (payload.rate_limits as CodexLogLimits) : null;
      if (!limits) continue;
      // 日志帧用的是 window_minutes,和接口的 limit_window_seconds 不是一个字段。
      const fromLog = (raw: unknown): RateWindow | null => {
        if (!isRecord(raw)) return null;
        const used = numberOr(raw.used_percent);
        if (used === null) return null;
        const resets = numberOr(raw.resets_at);
        return {
          usedPercent: used,
          windowMinutes: numberOr(raw.window_minutes),
          resetsAt: resets !== null ? resets * 1000 : null,
        };
      };
      const primary = fromLog(limits.primary);
      const secondary = fromLog(limits.secondary);
      if (!primary && !secondary) continue;
      const observedAt = stringOr(entry.timestamp);
      return {
        ...base('codex', 'Codex'),
        status: 'ok',
        source: 'local',
        identity: { plan: stringOr(limits.plan_type) },
        primary,
        secondary,
        details: sections(section('来源', [
          { label: '采集方式', value: '本机 rollout 日志', secondaryValue: observedAt },
        ])),
        updatedAt: nowMs,
        note: '官方额度接口没读到,这是本机日志里最后一帧服务端配额,可能已经过时。',
      };
    }
  }
  return null;
}

async function readCodexSnapshot(deps: QuotaDeps, nowMs: number): Promise<ProviderSnapshot> {
  const credential = await readCodexCredential();
  if (!credential) {
    const fallback = await codexSnapshotFromLogs(nowMs);
    if (fallback) return fallback;
    return {
      ...base('codex', 'Codex'),
      note: `没找到 ${path.join(codexHome(), 'auth.json')} 里的登录态,先跑一次 codex login。`,
    };
  }

  const result = await requestJson(CODEX_USAGE_URL, {
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
  }, deps);

  if (result.ok && isRecord(result.data)) return codexSnapshotFromApi(result.data, nowMs);

  const message = result.ok ? '额度接口返回了无法识别的结构' : result.message;
  const fallback = await codexSnapshotFromLogs(nowMs);
  if (fallback) return { ...fallback, note: `${message};已退回本机日志:${fallback.note ?? ''}` };
  return { ...base('codex', 'Codex'), status: 'error', error: message };
}

/* ----------------------------------------------------------------- Claude */

/**
 * 接口只给 utilization 和 resets_at,不给窗口长度,所以长度只能按 key 推。
 * 这是**长度查表**,不是"哪些窗口算数"的白名单 —— 判定真假窗口见 claudeWindow()。
 */
function claudeWindowMinutes(key: string): number | null {
  if (key === 'five_hour') return 300;
  if (key.startsWith('seven_day')) return 10080;
  return null;
}

const CLAUDE_WINDOW_TITLES: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  seven_day_sonnet: 'Sonnet',
  seven_day_opus: 'Opus',
  seven_day_cowork: 'Cowork',
  seven_day_routines: 'Routines',
  seven_day_oauth_apps: 'OAuth Apps',
};

const humanizeKey = (key: string): string =>
  CLAUDE_WINDOW_TITLES[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * 真实窗口的判据:**有 utilization 数值 + 有能解析的 resets_at**。
 * Anthropic 会往这个响应里塞一堆内部代号窗口(tangelo / nimbus_quill / …),
 * 它们 utilization=0 且 resets_at 为 null —— 当真实窗口显示就是 UI 上的幽灵 0%。
 * 用判据而不是 key 白名单,是为了以后新加的窗口能自动接住。
 */
function claudeWindow(key: string, raw: unknown): { window: RateWindow; real: boolean } | null {
  if (!isRecord(raw)) return null;
  const utilization = numberOr(raw.utilization);
  if (utilization === null) return null;
  const resetsRaw = stringOr(raw.resets_at);
  const parsed = resetsRaw ? Date.parse(resetsRaw) : NaN;
  const resetsAt = Number.isFinite(parsed) ? parsed : null;
  const real = resetsAt !== null;
  return {
    window: {
      usedPercent: utilization,
      windowMinutes: claudeWindowMinutes(key),
      resetsAt,
      ...(real ? {} : { isSyntheticPlaceholder: true as const }),
    },
    real,
  };
}

/** five_hour 缺席时补一个**标记过的**占位窗口,保持布局稳定又不冒充数据。 */
const syntheticFiveHour = (): RateWindow => ({
  usedPercent: 0,
  windowMinutes: 300,
  resetsAt: null,
  isSyntheticPlaceholder: true,
});

function claudeCredits(payload: Record<string, unknown>): ProviderCredits | null {
  const extra = isRecord(payload.extra_usage) ? payload.extra_usage : null;
  if (!extra || extra.is_enabled !== true) return null;
  const limit = numberOr(extra.monthly_limit);
  const used = numberOr(extra.used_credits);
  return {
    remaining: limit !== null && used !== null ? limit - used : null,
    total: limit,
    unit: stringOr(extra.currency) ?? 'credits',
    hint: '额外用量',
  };
}

function claudeSnapshotFromApi(
  payload: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  planFallback: string | null,
  origin: string,
  nowMs: number,
): ProviderSnapshot {
  const parsed = new Map<string, { window: RateWindow; real: boolean }>();
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'extra_usage' || key === 'spend' || key === 'limits') continue;
    const entry = claudeWindow(key, value);
    if (entry) parsed.set(key, entry);
  }

  const takeReal = (key: string): RateWindow | null => {
    const entry = parsed.get(key);
    if (!entry?.real) return null;
    parsed.delete(key);
    return entry.window;
  };

  const primary = takeReal('five_hour') ?? syntheticFiveHour();
  const secondary = takeReal('seven_day');
  const tertiary = takeReal('seven_day_opus') ?? takeReal('seven_day_sonnet');
  parsed.delete('five_hour');

  const extraRateWindows: NamedRateWindow[] = [];
  for (const [key, entry] of parsed) {
    // 只留真实窗口;占位的内部代号窗口不进 UI。
    if (!entry.real) continue;
    extraRateWindows.push({ id: key, title: humanizeKey(key), window: entry.window, usageKnown: true });
  }

  const account = isRecord(profile?.account) ? profile.account : null;
  const organization = isRecord(profile?.organization) ? profile.organization : null;
  const plan = stringOr(organization?.organization_type) ?? planFallback;

  return {
    ...base('claude', 'Claude Code'),
    status: 'ok',
    source: 'oauth',
    identity: {
      accountEmail: stringOr(account?.email),
      plan,
      organization: stringOr(organization?.name),
    },
    primary,
    secondary,
    tertiary,
    extraRateWindows,
    credits: claudeCredits(payload),
    details: sections(
      section('账户', [
        stringOr(account?.email) ? { label: '账号', value: stringOr(account?.email) as string } : null,
        plan ? { label: '套餐', value: plan } : null,
        { label: '凭据来源', value: origin === 'keychain' ? '钥匙串' : '凭据文件' },
      ]),
      section('配速', [
        paceRow('5 小时窗口', primary, nowMs),
        paceRow('7 天窗口', secondary, nowMs),
      ]),
    ),
    updatedAt: nowMs,
    note: primary.isSyntheticPlaceholder ? '服务端这次没下发 5 小时窗口,该行是占位,不是 0% 用量。' : null,
  };
}

/** 兜底:本机日志累加的近 5 小时 token。**不是**额度,所以一个窗口都不给。 */
async function claudeSnapshotFromLogs(nowMs: number): Promise<ProviderSnapshot | null> {
  const sinceMs = nowMs - CLAUDE_WINDOW_HOURS * 3600_000;
  const files = await recentLogs(claudeProjectsDir(), '.jsonl', sinceMs, 12);
  if (files.length === 0) return null;

  let tokens = 0;
  let requests = 0;
  for (const file of files) {
    let lines: string[];
    try {
      lines = await readTail(file, 2 * TAIL_BYTES);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(at) || at < sinceMs) continue;
      const message = isRecord(entry.message) ? entry.message : undefined;
      const usage = (message?.usage ?? entry.usage) as Record<string, unknown> | undefined;
      if (!usage) continue;
      const sum = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
        .reduce((total, key) => total + (numberOr(usage[key], 0) as number), 0);
      if (sum <= 0) continue;
      tokens += sum;
      requests += 1;
    }
  }
  if (requests === 0) return null;

  return {
    ...base('claude', 'Claude Code'),
    status: 'ok',
    source: 'local',
    details: sections(section('本机统计', [
      { label: `近 ${CLAUDE_WINDOW_HOURS} 小时`, value: `${tokens} tokens`, secondaryValue: `${requests} 次请求` },
    ])),
    updatedAt: nowMs,
    note: `官方额度接口没读到,这是本机日志累加的近 ${CLAUDE_WINDOW_HOURS} 小时用量,不是官方配额。`,
  };
}

async function readClaudeSnapshot(deps: QuotaDeps, nowMs: number): Promise<ProviderSnapshot> {
  const { credential, expiredOrigins } = await readClaudeCredential(nowMs, deps.keychainReader);
  if (!credential) {
    const fallback = await claudeSnapshotFromLogs(nowMs);
    const why = expiredOrigins.length > 0
      ? `本机 Claude 凭据已过期(${expiredOrigins.join('、')}),重新登录 Claude Code 后即可读到官方额度。`
      : '没找到 Claude Code 的登录态(钥匙串与 ~/.claude/.credentials.json 都没有),先登录一次。';
    if (fallback) return { ...fallback, note: `${why} ${fallback.note ?? ''}`.trim() };
    return { ...base('claude', 'Claude Code'), note: why };
  }

  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
  };
  const result = await requestJson(CLAUDE_USAGE_URL, headers, deps);

  if (result.ok && isRecord(result.data)) {
    // 身份是锦上添花,拿不到不影响额度本身。
    const profileResult = await requestJson(CLAUDE_PROFILE_URL, headers, deps);
    const profile = profileResult.ok && isRecord(profileResult.data) ? profileResult.data : null;
    return claudeSnapshotFromApi(
      result.data,
      profile,
      credential.subscriptionType ?? credential.rateLimitTier,
      credential.origin,
      nowMs,
    );
  }

  const message = result.ok ? '额度接口返回了无法识别的结构' : result.message;
  const fallback = await claudeSnapshotFromLogs(nowMs);
  if (fallback) return { ...fallback, note: `${message};已退回本机日志:${fallback.note ?? ''}` };
  return { ...base('claude', 'Claude Code'), status: 'error', error: message };
}

/* ----------------------------------------------------------------- Gemini */

/**
 * Gemini 这一轮**只做到凭据判定为止**,拿不到就如实说,不返回任何估算。
 *
 * 差的那一步是 token 刷新:`~/.gemini/oauth_creds.json` 里的 access_token 生命
 * 很短(本机实测已过期约三个月),必须用 refresh_token 走
 * `POST https://oauth2.googleapis.com/token`(grant_type=refresh_token)换新的。
 * 而 Google OAuth 的 client_id / client_secret 上游是从本机 gemini-cli 包里的
 * `oauth2.js` 用正则抠出来的 —— 依赖别人家的内部文件布局,一次升级就会碎,
 * 所以这轮不做。真要补,建议:
 *   1. 只在内存里用刷新后的 token,**不写回** oauth_creds.json
 *      (写回要原子写 + 处理与 CLI 自身刷新的竞态,收益不抵风险);
 *   2. 或者等 gemini-cli 暴露一条正式的本地配额命令再接。
 *
 * 配额接口本身(留给下轮):
 *   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota  body {"project": "<id>"}
 *   tier 用 :loadCodeAssist;project 兜底 GET cloudresourcemanager/v1/projects
 */
async function readGeminiSnapshot(nowMs: number): Promise<ProviderSnapshot> {
  const snapshot = base('gemini', 'Gemini');
  const authType = await readGeminiAuthType();
  const credential = await readGeminiCredential(nowMs);

  if (!credential) {
    return { ...snapshot, note: '本机没有 ~/.gemini/oauth_creds.json,先跑一次 gemini 登录。' };
  }
  if (authType && authType !== 'oauth-personal') {
    return {
      ...snapshot,
      note: `本机 gemini 的登录方式是 ${authType},个人配额接口只对 oauth-personal 开放;换成 Google 账号登录后才能读到额度。`,
    };
  }
  if (credential.expired) {
    const when = credential.expiryDate ? new Date(credential.expiryDate).toISOString().slice(0, 10) : '未知';
    return {
      ...snapshot,
      note: `本机 Gemini 凭据已于 ${when} 过期,需要重新跑一次 gemini 登录;自动刷新流程尚未接入(见代码注释)。`,
    };
  }
  return {
    ...snapshot,
    note: '凭据可用,但 Gemini 配额接口尚未接入(需要 OAuth token 刷新流程,见代码注释)。',
  };
}

/* --------------------------------------------------------------- 未接入的家 */

/**
 * 还没有可用数据源的 provider **照样进清单**,并写清楚缺的是什么。
 * 授权是陆续补的,清单要能回答"还差谁",而不是让缺的那几家凭空消失。
 */
const PENDING_PROVIDERS: { id: string; label: string; note: string }[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    // 查证过 cursor.com/docs(2026-08):个人 key 只有 `GET /v1/me` 能拿身份,
    // 用量接口 `POST /teams/daily-usage-data`、`POST /teams/spend` 全部要
    // Enterprise 团队的 admin key。个人账号**没有**任何公开的用量接口 ——
    // 所以这里只存凭据、不接额度,不去编一个端点出来。
    note: '本机有 ~/.cursor,但 Cursor 只给 Enterprise 团队的 admin key 开放用量接口(/teams/spend 等),'
      + '个人账号没有公开的用量接口;用量请在 cursor.com 后台查看。',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    note: '本机有 ~/.config/opencode,但它按你自己配的上游计费,没有统一的额度接口可读;'
      + '额度要去你配的那家上游(Anthropic / OpenAI / OpenRouter 等)自己看。',
  },
];

/* ------------------------------------------------------------------ 对外 */

let cache: { at: number; value: ProviderSnapshot[] } | null = null;

/**
 * 全部 provider 的额度快照。60 秒缓存 —— 面板轮询不该反复打官方接口。
 * 单家失败不拖累其他家:allSettled + 逐个兜底。
 */
export async function readAiQuota(deps: QuotaDeps = {}): Promise<ProviderSnapshot[]> {
  const nowMs = deps.nowMs ?? Date.now();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const probes = await Promise.allSettled([
    readCodexSnapshot(deps, nowMs),
    readClaudeSnapshot(deps, nowMs),
    readGeminiSnapshot(nowMs),
    readGrokSnapshot((url, headers) => requestJson(url, headers, deps), nowMs),
  ]);
  const labels: [string, string][] = [
    ['codex', 'Codex'], ['claude', 'Claude Code'], ['gemini', 'Gemini'], ['grok', 'Grok'],
  ];
  const value = probes.map((probe, index): ProviderSnapshot => {
    if (probe.status === 'fulfilled') return probe.value;
    const [id, label] = labels[index];
    const reason = probe.reason instanceof Error ? probe.reason.message : String(probe.reason);
    return { ...base(id, label), status: 'error', error: `采集异常:${reason}` };
  });

  value.push(...PENDING_PROVIDERS.map((provider): ProviderSnapshot => ({
    ...base(provider.id, provider.label),
    note: provider.note,
  })));

  cache = { at: Date.now(), value };
  return value;
}

/** 测试与手动刷新用。 */
export function clearAiQuotaCache(): void {
  cache = null;
}
