import { appConfigDb, getConnection } from '@/modules/database/index.js';
import { arsenalPrice } from '@/shared/model-arsenal.js';


export const DEFAULT_PRICES_PER_MILLION: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
  haiku: { input: 0.8, output: 4 },
  'gpt-5': { input: 2, output: 8 },
  'gpt-4': { input: 5, output: 15 },
  grok: { input: 5, output: 15 },
};

const MODEL_PRICES_KEY = 'usage_model_prices_per_million';
export type ModelPriceTable = Record<string, { input: number; output: number }>;

export function getModelPrices(): ModelPriceTable {
  try {
    const parsed = JSON.parse(appConfigDb.get(MODEL_PRICES_KEY) || '{}') as ModelPriceTable;
    return { ...DEFAULT_PRICES_PER_MILLION, ...parsed };
  } catch {
    return { ...DEFAULT_PRICES_PER_MILLION };
  }
}

export function setModelPrices(value: unknown): ModelPriceTable {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalized: ModelPriceTable = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!key.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const inputPrice = Number(row.input);
    const outputPrice = Number(row.output);
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) continue;
    normalized[key.trim().toLowerCase()] = { input: inputPrice, output: outputPrice };
  }
  appConfigDb.set(MODEL_PRICES_KEY, JSON.stringify(normalized));
  return getModelPrices();
}

/** Only the user-set overrides (not merged with defaults). */
function getUserModelPrices(): ModelPriceTable {
  try {
    const parsed = JSON.parse(appConfigDb.get(MODEL_PRICES_KEY) || '{}') as ModelPriceTable;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function modelPrice(provider: string, model?: string | null) {
  const haystack = String(model || provider).toLowerCase();
  // 1. A user price override always wins — it's how someone prices a custom
  //    Leoapi endpoint. Match ONLY user-set keys, longest first, so a specific
  //    key ("custom-opus") beats a coarse one and a built-in default key can
  //    never mask the user's override.
  const userTable = getUserModelPrices();
  const userKey = Object.keys(userTable)
    .filter((candidate) => haystack.includes(candidate.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (userKey) return userTable[userKey];
  // 2. Precise arsenal price for the exact model.
  const arsenal = arsenalPrice(provider, model);
  if (arsenal) return arsenal;
  // 3. Coarse built-in default table, then zero (unknown → tokens shown, no
  //    fabricated cost).
  const defKey = Object.keys(DEFAULT_PRICES_PER_MILLION).find((candidate) => haystack.includes(candidate.toLowerCase()));
  return (defKey && DEFAULT_PRICES_PER_MILLION[defKey]) || { input: 0, output: 0 };
}

export function estimateUsageCostUsd(provider: string, model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const price = modelPrice(provider, model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export type UsageRecord = {
  projectPath?: string | null;
  provider: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
};

export type UsageSummary = {
  day: string;
  provider: string;
  model: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
};

export const usageDb = {
  record(record: UsageRecord): void {
    const db = getConnection();
    const day = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO usage_daily
        (day, project_path, provider, model, session_count, input_tokens, output_tokens, cache_tokens, cost_usd, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(day, project_path, provider, model) DO UPDATE SET
        session_count = usage_daily.session_count + 1,
        input_tokens = usage_daily.input_tokens + excluded.input_tokens,
        output_tokens = usage_daily.output_tokens + excluded.output_tokens,
        cache_tokens = usage_daily.cache_tokens + excluded.cache_tokens,
        cost_usd = usage_daily.cost_usd + excluded.cost_usd,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      day,
      record.projectPath ?? null,
      record.provider,
      record.model ?? null,
      Math.max(0, Math.floor(record.inputTokens ?? 0)),
      Math.max(0, Math.floor(record.outputTokens ?? 0)),
      Math.max(0, Math.floor(record.cacheTokens ?? 0)),
      Math.max(0, Number(record.costUsd ?? 0)),
    );
  },

  summary(options: { from?: string; to?: string; projectPath?: string; provider?: string } = {}): UsageSummary[] {
    const clauses = ['1 = 1'];
    const params: unknown[] = [];
    if (options.from) { clauses.push('day >= ?'); params.push(options.from); }
    if (options.to) { clauses.push('day <= ?'); params.push(options.to); }
    if (options.projectPath) { clauses.push('project_path = ?'); params.push(options.projectPath); }
    if (options.provider) { clauses.push('provider = ?'); params.push(options.provider); }
    return getConnection().prepare(`
      SELECT day, provider, model, session_count AS sessionCount,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_tokens AS cacheTokens, cost_usd AS costUsd
      FROM usage_daily WHERE ${clauses.join(' AND ')}
      ORDER BY day DESC, cost_usd DESC
    `).all(...params) as UsageSummary[];
  },
};
