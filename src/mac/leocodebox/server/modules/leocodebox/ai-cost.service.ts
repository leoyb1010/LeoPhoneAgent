import { createReadStream, promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pricingTable from './model-pricing.json' with { type: 'json' };

/**
 * [T-quota-cost] 本机成本聚合。
 *
 * 与 CodexBar 的 `codexbar cost` 同构:纯本地,只读各家 CLI 自己写下的 JSONL,
 * 按天汇总 token 与花费,并给出按模型的拆分。字段名沿用它的 CLI 契约,
 * 方便对照:daily[] / modelBreakdowns[] / last30Days* / totals。
 *
 * 单价表从 CodexBar 的 CostUsagePricing.swift 抄来(MIT,见 NOTICE),
 * 是"按 token 单价"而不是"按次",所以 cache 读写要分开计价。
 * 表里没有的模型不猜价 —— 计入 token,但花费按 0 记,并在 unpricedModels 里点名。
 */

type Price = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
const PRICES = pricingTable as Record<string, Price>;

const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CLAUDE_DIRS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.config', 'claude', 'projects'),
];

const WINDOW_DAYS = 30;
const CACHE_MS = 5 * 60_000;
/** 单文件最多读尾部这么多:会话日志能到几十 MB,30 天的量靠文件 mtime 过滤已经够窄。 */
const TAIL_BYTES = 4 * 1024 * 1024;

export type ModelBreakdown = { modelName: string; tokens: number; cost: number };
export type DailyCost = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
};
export type ProviderCost = {
  provider: string;
  source: string;
  updatedAt: string;
  todayTokens: number;
  todayCostUSD: number;
  last30DaysTokens: number;
  last30DaysCostUSD: number;
  daily: DailyCost[];
  modelBreakdowns: ModelBreakdown[];
  /** 单价表里没有的模型:token 算进去了,花费没有。 */
  unpricedModels: string[];
};

type Bucket = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; models: Map<string, { tokens: number; cost: number }>;
};

const emptyBucket = (): Bucket => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Map(),
});

/** 模型名对齐单价表:先精确,再按前缀取最长匹配(带日期后缀的版本号很常见)。 */
export function priceFor(model: string): Price | null {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  let best: string | null = null;
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : null;
}

export function costOf(model: string, usage: {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
}): { cost: number; priced: boolean } {
  const price = priceFor(model);
  if (!price) return { cost: 0, priced: false };
  const cost = (usage.input ?? 0) * (price.input ?? 0)
    + (usage.output ?? 0) * (price.output ?? 0)
    + (usage.cacheRead ?? 0) * (price.cacheRead ?? price.input ?? 0)
    + (usage.cacheWrite ?? 0) * (price.cacheWrite ?? price.input ?? 0);
  return { cost, priced: true };
}

async function readTail(filePath: string): Promise<string[]> {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - TAIL_BYTES);
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

async function recentLogs(root: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
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
      if (!entry.name.endsWith('.jsonl')) return;
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs >= sinceMs) found.push(full);
      } catch {
        // 轮转中消失的文件,跳过。
      }
    }));
  };
  await walk(root, 0);
  return found;
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function add(buckets: Map<string, Bucket>, day: string, model: string, usage: {
  input: number; output: number; cacheRead: number; cacheWrite: number;
}, unpriced: Set<string>): void {
  const bucket = buckets.get(day) ?? emptyBucket();
  bucket.input += usage.input;
  bucket.output += usage.output;
  bucket.cacheRead += usage.cacheRead;
  bucket.cacheWrite += usage.cacheWrite;
  const { cost, priced } = costOf(model, usage);
  if (!priced && model) unpriced.add(model);
  bucket.cost += cost;
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const entry = bucket.models.get(model) ?? { tokens: 0, cost: 0 };
  entry.tokens += tokens;
  entry.cost += cost;
  bucket.models.set(model, entry);
  buckets.set(day, bucket);
}

function summarise(provider: string, source: string, buckets: Map<string, Bucket>, unpriced: Set<string>): ProviderCost {
  const today = dayKey(Date.now());
  const daily: DailyCost[] = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, bucket]) => ({
      date,
      inputTokens: bucket.input,
      outputTokens: bucket.output,
      cacheReadTokens: bucket.cacheRead,
      cacheCreationTokens: bucket.cacheWrite,
      totalTokens: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
      totalCost: bucket.cost,
      modelsUsed: [...bucket.models.keys()].filter(Boolean),
    }));

  const models = new Map<string, ModelBreakdown>();
  for (const bucket of buckets.values()) {
    for (const [name, entry] of bucket.models) {
      if (!name) continue;
      const existing = models.get(name) ?? { modelName: name, tokens: 0, cost: 0 };
      existing.tokens += entry.tokens;
      existing.cost += entry.cost;
      models.set(name, existing);
    }
  }

  const todayRow = daily.find((row) => row.date === today);
  return {
    provider,
    source,
    updatedAt: new Date().toISOString(),
    todayTokens: todayRow?.totalTokens ?? 0,
    todayCostUSD: todayRow?.totalCost ?? 0,
    last30DaysTokens: daily.reduce((sum, row) => sum + row.totalTokens, 0),
    last30DaysCostUSD: daily.reduce((sum, row) => sum + row.totalCost, 0),
    daily,
    modelBreakdowns: [...models.values()].sort((a, b) => b.cost - a.cost),
    unpricedModels: [...unpriced],
  };
}

/** Codex:token_count 事件的 last_token_usage 是增量,直接累加;模型名取同文件里最近一次声明。 */
async function codexCost(sinceMs: number): Promise<ProviderCost> {
  const buckets = new Map<string, Bucket>();
  const unpriced = new Set<string>();
  for (const file of await recentLogs(CODEX_DIR, sinceMs)) {
    let lines: string[];
    try {
      lines = await readTail(file);
    } catch {
      continue;
    }
    let model = '';
    for (const line of lines) {
      if (!line.includes('"model"') && !line.includes('token_count')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = (entry.payload ?? entry) as Record<string, unknown>;
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      if (payload.type !== 'token_count') continue;
      const info = payload.info as Record<string, unknown> | undefined;
      const last = info?.last_token_usage as Record<string, number> | undefined;
      if (!last) continue;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(at) || at < sinceMs) continue;
      add(buckets, dayKey(at), model, {
        input: (last.input_tokens ?? 0) - (last.cached_input_tokens ?? 0),
        output: last.output_tokens ?? 0,
        cacheRead: last.cached_input_tokens ?? 0,
        cacheWrite: last.cache_write_input_tokens ?? 0,
      }, unpriced);
    }
  }
  return summarise('codex', '~/.codex/sessions', buckets, unpriced);
}

/** Claude:每条 assistant 消息自带 message.model 与 message.usage。 */
async function claudeCost(sinceMs: number): Promise<ProviderCost> {
  const buckets = new Map<string, Bucket>();
  const unpriced = new Set<string>();
  for (const dir of CLAUDE_DIRS) {
    for (const file of await recentLogs(dir, sinceMs)) {
      let lines: string[];
      try {
        lines = await readTail(file);
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
        const usage = (message?.usage ?? entry.usage) as Record<string, number> | undefined;
        if (!usage) continue;
        const model = String(message?.model ?? '');
        add(buckets, dayKey(at), model, {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        }, unpriced);
      }
    }
  }
  return summarise('claude', '~/.claude/projects', buckets, unpriced);
}

let cache: { at: number; value: ProviderCost[] } | null = null;

/** 30 天成本快照。扫日志比读额度贵得多,缓存 5 分钟。 */
export async function readAiCost(): Promise<ProviderCost[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const sinceMs = Date.now() - WINDOW_DAYS * 24 * 3600_000;
  const value = await Promise.all([codexCost(sinceMs), claudeCost(sinceMs)]);
  cache = { at: Date.now(), value };
  return value;
}

export function clearAiCostCache(): void {
  cache = null;
}
