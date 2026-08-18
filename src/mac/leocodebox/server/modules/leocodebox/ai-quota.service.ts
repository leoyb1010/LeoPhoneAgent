import { createReadStream, promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * [T-quota-bar] 本机 AI 额度采集。
 *
 * 思路来自 CodexBar(steipete/CodexBar):不登录每一家服务,而是读各家 CLI **已经
 * 落在本机**的状态。这里只吸收对 leocodebox 有意义的那部分,并且严格区分两种数字:
 *
 *  - `authoritative: true`  —— 服务端下发的真实额度窗口。目前只有 Codex 有:
 *    它的 rollout 日志里每个 token_count 事件都带 `rate_limits`
 *    (used_percent / window_minutes / resets_at / plan_type / credits)。
 *  - `authoritative: false` —— 本机日志累加出来的滚动用量。Claude Code 的日志
 *    只有逐条 usage,没有配额窗口,所以只能给"最近 N 小时用了多少 token",
 *    这**不是**官方额度,UI 上必须写清楚。
 *
 * 没有的东西不猜:读不到就返回 unavailable,不填 0 也不编百分比。
 */

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** 只读文件尾部:会话日志能到几十 MB,配额信息总在最后几条。 */
const TAIL_BYTES = 512 * 1024;
const CACHE_MS = 60_000;
/** Claude 滚动窗口:官方计费窗口是 5 小时,这里对齐它便于对照。 */
const CLAUDE_WINDOW_HOURS = 5;

export type QuotaWindow = {
  name: string;
  usedPercent: number;
  windowMinutes: number;
  /** epoch 秒。null = 该窗口没给重置时间。 */
  resetsAt: number | null;
  /** 配速:实际用量相对"按时间均匀消耗"的偏差。窗口没有重置时间时为 null。 */
  pace?: UsagePace | null;
};

/**
 * 配速模型,公式抄自 CodexBar 的 UsagePace(MIT,见 NOTICE):
 *   expected = 已过时间 / 窗口长度 × 100
 *   delta    = 实际已用% − expected
 *   分档     |δ|≤2 持平;≤6 略;≤12 明显;更大为严重
 * 右侧标签:按当前速率能撑到重置 → lastsToReset;否则给耗尽预计秒数。
 */
export type UsagePace = {
  expectedUsedPercent: number;
  deltaPercent: number;
  stage: 'onTrack' | 'slightlyAhead' | 'ahead' | 'farAhead' | 'slightlyBehind' | 'behind' | 'farBehind';
  etaSeconds: number | null;
  lastsToReset: boolean;
};

export type QuotaProvider = {
  id: string;
  label: string;
  /** true = 服务端下发的真实额度;false = 本机日志累加的滚动用量。 */
  authoritative: boolean;
  source: string;
  available: boolean;
  plan?: string | null;
  windows?: QuotaWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  rolling?: { windowHours: number; tokens: number; requests: number } | null;
  observedAt?: string | null;
  note?: string;
};

type Cached = { at: number; value: QuotaProvider[] };
let cache: Cached | null = null;

/** 读文件尾部,丢掉被截断的首行。 */
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
        // 文件在遍历途中消失(会话轮转)——跳过即可。
      }
    }));
  };

  await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((item) => item.file);
}

type CodexRateLimits = {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string } | null;
  plan_type?: string | null;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function stageFor(delta: number): UsagePace['stage'] {
  const magnitude = Math.abs(delta);
  if (magnitude <= 2) return 'onTrack';
  if (magnitude <= 6) return delta >= 0 ? 'slightlyAhead' : 'slightlyBehind';
  if (magnitude <= 12) return delta >= 0 ? 'ahead' : 'behind';
  return delta >= 0 ? 'farAhead' : 'farBehind';
}

export function computePace(window: QuotaWindow, nowMs = Date.now()): UsagePace | null {
  if (!window.resetsAt || !window.windowMinutes) return null;
  const durationSeconds = window.windowMinutes * 60;
  const untilReset = window.resetsAt - Math.floor(nowMs / 1000);
  if (untilReset <= 0 || untilReset > durationSeconds) return null;
  const elapsed = clamp(durationSeconds - untilReset, 0, durationSeconds);
  const expected = clamp((elapsed / durationSeconds) * 100, 0, 100);
  const actual = clamp(window.usedPercent, 0, 100);
  // 窗口刚开就已有用量,说明这个窗口不是从零开始的,不给配速结论。
  if (elapsed === 0 && actual > 0) return null;

  let etaSeconds: number | null = null;
  let lastsToReset = false;
  if (actual >= 100) {
    etaSeconds = 0;
  } else if (elapsed > 0 && actual > 0) {
    const rate = actual / elapsed;
    const candidate = (100 - actual) / rate;
    if (candidate >= untilReset) lastsToReset = true;
    else etaSeconds = candidate;
  } else if (elapsed > 0) {
    lastsToReset = true;
  }

  const delta = actual - expected;
  return { expectedUsedPercent: expected, deltaPercent: delta, stage: stageFor(delta), etaSeconds, lastsToReset };
}

function windowFrom(name: string, raw: CodexRateLimits['primary']): QuotaWindow | null {
  if (!raw || typeof raw.used_percent !== 'number') return null;
  const window: QuotaWindow = {
    name,
    usedPercent: raw.used_percent,
    windowMinutes: typeof raw.window_minutes === 'number' ? raw.window_minutes : 0,
    resetsAt: typeof raw.resets_at === 'number' ? raw.resets_at : null,
  };
  return { ...window, pace: computePace(window) };
}

/** Codex:从最近的 rollout 日志尾部取最后一帧 rate_limits。 */
async function readCodexQuota(): Promise<QuotaProvider> {
  const base: QuotaProvider = {
    id: 'codex',
    label: 'Codex',
    authoritative: true,
    source: '~/.codex/sessions',
    available: false,
    note: 'Codex 服务端下发的额度窗口',
  };

  // 只看最近 3 天的会话:更早的日志里的百分比已经没有参考价值。
  const files = await recentLogs(CODEX_SESSIONS_DIR, '.jsonl', Date.now() - 3 * 24 * 3600_000, 5);
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
      const payload = (entry.payload ?? entry) as Record<string, unknown>;
      const limits = payload.rate_limits as CodexRateLimits | undefined;
      if (!limits) continue;

      const windows = [windowFrom('primary', limits.primary), windowFrom('secondary', limits.secondary)]
        .filter((window): window is QuotaWindow => Boolean(window));
      if (windows.length === 0) continue;

      return {
        ...base,
        available: true,
        plan: limits.plan_type ?? null,
        windows,
        credits: limits.credits
          ? {
            hasCredits: limits.credits.has_credits === true,
            unlimited: limits.credits.unlimited === true,
            balance: String(limits.credits.balance ?? '0'),
          }
          : null,
        observedAt: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      };
    }
  }
  return base;
}

/** Claude:日志里没有配额窗口,只能按时间窗累加自己的 usage。 */
async function readClaudeRolling(): Promise<QuotaProvider> {
  const base: QuotaProvider = {
    id: 'claude',
    label: 'Claude Code',
    authoritative: false,
    source: '~/.claude/projects',
    available: false,
    note: `本机日志累加的近 ${CLAUDE_WINDOW_HOURS} 小时用量,不是官方额度`,
  };

  const sinceMs = Date.now() - CLAUDE_WINDOW_HOURS * 3600_000;
  const files = await recentLogs(CLAUDE_PROJECTS_DIR, '.jsonl', sinceMs, 12);
  if (files.length === 0) return base;

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
      const message = entry.message as Record<string, unknown> | undefined;
      const usage = (message?.usage ?? entry.usage) as Record<string, unknown> | undefined;
      if (!usage) continue;
      const sum = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
        .reduce((total, key) => total + (typeof usage[key] === 'number' ? (usage[key] as number) : 0), 0);
      if (sum <= 0) continue;
      tokens += sum;
      requests += 1;
    }
  }

  return {
    ...base,
    available: requests > 0,
    rolling: { windowHours: CLAUDE_WINDOW_HOURS, tokens, requests },
    observedAt: new Date().toISOString(),
  };
}

/**
 * 还没有本机数据源的 provider。它们**照样进清单**,状态是"未接入"——
 * 授权是陆续补的,清单要能回答"还差谁",而不是让缺的那几家凭空消失。
 * 接进来的方式各不相同(Cursor/Gemini 要浏览器会话或 OAuth),所以这里
 * 只占位,不假装读到过什么。
 */
const PENDING_PROVIDERS: { id: string; label: string; note: string }[] = [
  { id: 'cursor', label: 'Cursor', note: '需要浏览器会话或 API 凭据才能读到用量' },
  { id: 'grok', label: 'Grok', note: '需要 xAI 账号凭据才能读到用量' },
  { id: 'gemini', label: 'Gemini', note: '需要 Google OAuth 凭据才能读到配额' },
  { id: 'opencode', label: 'OpenCode', note: '本机未落用量记录' },
];

/** 全部 provider 的额度快照。60 秒缓存 —— 面板轮询不该反复扫日志。 */
export async function readAiQuota(): Promise<QuotaProvider[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const probed = await Promise.all([readCodexQuota(), readClaudeRolling()]);
  const value = probed.concat(PENDING_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    authoritative: false,
    source: '未接入',
    available: false,
    note: provider.note,
  })));
  cache = { at: Date.now(), value };
  return value;
}

/** 测试与手动刷新用。 */
export function clearAiQuotaCache(): void {
  cache = null;
}
