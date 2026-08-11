/**
 * Model Arsenal — a curated, offline dataset of coding-agent models across
 * providers, with per-model context window, output cap, pricing (USD per 1M
 * tokens), and capability flags.
 *
 * It replaces two tiny hardcoded tables (usage cost's 6-entry price map and
 * model-metadata's 12-entry context map) with one authoritative source, so
 * usage cost and context reporting are precise per model instead of by a
 * coarse substring guess. Both consumers fall back to their old tables when a
 * model is not in the arsenal, so nothing regresses for unknown models.
 *
 * Data is embedded (no build-time network fetch) to keep the packaged app
 * fully offline and reproducible. Prices are list prices in USD per 1M tokens
 * and are best-effort as of 2026-07; a user price override in usage settings
 * still wins for cost, and unknown models degrade gracefully.
 */

export type ArsenalModel = {
  /** Provider key as leocodebox names it (claude/codex/gemini/grok/…). */
  provider: string;
  /** Model id or a lowercase match token (matched as a substring, longest-first). */
  id: string;
  /** Human label for the录入 UI. */
  label: string;
  contextWindow: number;
  maxOutput: number;
  /** USD per 1M input / output tokens; cacheReadPerM optional. */
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
  wireApi: 'anthropic-messages' | 'openai-responses' | 'openai-completions';
};

/**
 * Ordered so that more specific ids come before their prefixes — lookups match
 * the FIRST (and, among ties, the longest) id contained in the query string.
 */
export const MODEL_ARSENAL: ArsenalModel[] = [
  // ---- Anthropic / Claude ----
  { provider: 'claude', id: 'claude-opus-4', label: 'Claude Opus 4', contextWindow: 200_000, maxOutput: 32_000, inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'claude-sonnet-4', label: 'Claude Sonnet 4', contextWindow: 200_000, maxOutput: 64_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'claude-haiku-4', label: 'Claude Haiku 4', contextWindow: 200_000, maxOutput: 32_000, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', contextWindow: 200_000, maxOutput: 64_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', contextWindow: 200_000, maxOutput: 8_192, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, vision: true, reasoning: false, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', contextWindow: 200_000, maxOutput: 8_192, inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, vision: true, reasoning: false, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'opus', label: 'Claude Opus', contextWindow: 200_000, maxOutput: 32_000, inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet', contextWindow: 200_000, maxOutput: 64_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },
  { provider: 'claude', id: 'haiku', label: 'Claude Haiku', contextWindow: 200_000, maxOutput: 32_000, inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, vision: true, reasoning: true, tools: true, wireApi: 'anthropic-messages' },

  // ---- OpenAI / Codex ----
  { provider: 'codex', id: 'gpt-5-codex', label: 'GPT-5 Codex', contextWindow: 400_000, maxOutput: 128_000, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, vision: true, reasoning: true, tools: true, wireApi: 'openai-responses' },
  { provider: 'codex', id: 'gpt-5-mini', label: 'GPT-5 mini', contextWindow: 400_000, maxOutput: 128_000, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025, vision: true, reasoning: true, tools: true, wireApi: 'openai-responses' },
  { provider: 'codex', id: 'gpt-5', label: 'GPT-5', contextWindow: 400_000, maxOutput: 128_000, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125, vision: true, reasoning: true, tools: true, wireApi: 'openai-responses' },
  { provider: 'codex', id: 'o4-mini', label: 'o4-mini', contextWindow: 200_000, maxOutput: 100_000, inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.275, vision: true, reasoning: true, tools: true, wireApi: 'openai-responses' },
  { provider: 'codex', id: 'gpt-4.1', label: 'GPT-4.1', contextWindow: 1_047_576, maxOutput: 32_768, inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5, vision: true, reasoning: false, tools: true, wireApi: 'openai-responses' },
  { provider: 'codex', id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000, maxOutput: 16_384, inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, vision: true, reasoning: false, tools: true, wireApi: 'openai-completions' },

  // ---- Google / Gemini ----
  { provider: 'gemini', id: 'gemini-3-pro', label: 'Gemini 3 Pro', contextWindow: 1_048_576, maxOutput: 65_536, inputPerM: 2, outputPerM: 12, cacheReadPerM: 0.5, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'gemini', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_048_576, maxOutput: 65_536, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.31, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'gemini', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_048_576, maxOutput: 65_536, inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.075, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'gemini', id: 'gemini', label: 'Gemini', contextWindow: 1_048_576, maxOutput: 65_536, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.31, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },

  // ---- xAI / Grok ----
  { provider: 'grok', id: 'grok-4', label: 'Grok 4', contextWindow: 256_000, maxOutput: 64_000, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.75, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'grok', id: 'grok-code', label: 'Grok Code', contextWindow: 256_000, maxOutput: 64_000, inputPerM: 0.2, outputPerM: 1.5, cacheReadPerM: 0.02, vision: false, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'grok', id: 'grok', label: 'Grok', contextWindow: 131_072, maxOutput: 32_000, inputPerM: 5, outputPerM: 15, vision: false, reasoning: false, tools: true, wireApi: 'openai-completions' },

  // ---- Cursor ----
  { provider: 'cursor', id: 'cursor', label: 'Cursor (auto)', contextWindow: 200_000, maxOutput: 32_000, inputPerM: 0, outputPerM: 0, vision: true, reasoning: true, tools: true, wireApi: 'openai-completions' },

  // ---- OpenCode / portable open models ----
  { provider: 'opencode', id: 'deepseek-v3', label: 'DeepSeek V3', contextWindow: 128_000, maxOutput: 8_192, inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07, vision: false, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'deepseek-r1', label: 'DeepSeek R1', contextWindow: 128_000, maxOutput: 32_768, inputPerM: 0.55, outputPerM: 2.19, cacheReadPerM: 0.14, vision: false, reasoning: true, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'qwen3-coder', label: 'Qwen3 Coder', contextWindow: 262_144, maxOutput: 65_536, inputPerM: 0.3, outputPerM: 1.2, vision: false, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'kimi-k2', label: 'Kimi K2', contextWindow: 131_072, maxOutput: 16_384, inputPerM: 0.15, outputPerM: 2.5, vision: false, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'mistral-medium', label: 'Mistral Medium', contextWindow: 128_000, maxOutput: 8_192, inputPerM: 0.4, outputPerM: 2, vision: true, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'devstral', label: 'Devstral 2', contextWindow: 256_000, maxOutput: 16_384, inputPerM: 0.4, outputPerM: 2, vision: false, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'llama-4', label: 'Llama 4', contextWindow: 1_048_576, maxOutput: 16_384, inputPerM: 0.2, outputPerM: 0.6, vision: true, reasoning: false, tools: true, wireApi: 'openai-completions' },
  { provider: 'opencode', id: 'glm-4.6', label: 'GLM-4.6', contextWindow: 200_000, maxOutput: 16_384, inputPerM: 0.4, outputPerM: 1.75, vision: false, reasoning: true, tools: true, wireApi: 'openai-completions' },
];

// Longest ids first so "gpt-5-codex" wins over "gpt-5" when both are substrings.
const ARSENAL_BY_LENGTH = [...MODEL_ARSENAL].sort((a, b) => b.id.length - a.id.length);

/**
 * Best arsenal entry for a (provider, model) pair. Prefers an entry whose id is
 * a substring of the model within the same provider; falls back to a
 * cross-provider id match (covers Leoapi custom providers whose target differs
 * from the model's home vendor). Returns null when nothing matches.
 */
export function getArsenalModel(provider: string | null | undefined, model: string | null | undefined): ArsenalModel | null {
  const providerKey = String(provider || '').toLowerCase();
  const haystack = String(model || provider || '').toLowerCase();
  if (!haystack) return null;
  const sameProvider = ARSENAL_BY_LENGTH.find((entry) => entry.provider === providerKey && haystack.includes(entry.id));
  if (sameProvider) return sameProvider;
  return ARSENAL_BY_LENGTH.find((entry) => haystack.includes(entry.id)) ?? null;
}

/** Arsenal-precise context window, or null when the model is unknown. */
export function arsenalContextWindow(provider: string | null | undefined, model: string | null | undefined): number | null {
  return getArsenalModel(provider, model)?.contextWindow ?? null;
}

/** Arsenal-precise price (USD per 1M input/output), or null when unknown. */
export function arsenalPrice(provider: string | null | undefined, model: string | null | undefined): { input: number; output: number } | null {
  const entry = getArsenalModel(provider, model);
  return entry ? { input: entry.inputPerM, output: entry.outputPerM } : null;
}

/** Whole arsenal for the录入 UI, grouped by provider. */
export function listArsenal(): ArsenalModel[] {
  return MODEL_ARSENAL;
}
