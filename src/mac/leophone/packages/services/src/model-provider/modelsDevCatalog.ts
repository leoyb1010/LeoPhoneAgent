import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * [leo] models.dev 公共模型目录(https://models.dev/api.json),给「从接口获取模型」补展示名、
 * 上下文/输出上限和能力标记。
 *
 * - 最多 24 小时联网一次,结果落盘到应用数据目录;联网失败时沿用过期缓存,一次都没拿到就返回 null。
 * - 只读公共 JSON,不带任何凭据。
 */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** 联网失败后的冷却时间,避免离线时每次打开设置页都卡 10 秒超时。 */
const FAILURE_BACKOFF_MS = 10 * 60_000;

export interface ModelsDevModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly vision?: boolean;
  readonly tools?: boolean;
  readonly reasoning?: boolean;
  readonly releaseDate?: string;
  /** 输出模态里没有 text(纯生图/语音)。 */
  readonly nonTextOutput?: boolean;
}

export interface ModelsDevCatalog {
  /** 先按完整 ID,再去掉 `vendor/` 前缀查。 */
  lookup(modelId: string): ModelsDevModel | undefined;
  /** 按供应商 API 地址匹配 models.dev 里的供应商,返回其模型列表。 */
  modelsForBaseUrl(baseUrl: string): readonly ModelsDevModel[];
}

export interface ModelsDevCatalogSource {
  load(): Promise<ModelsDevCatalog | null>;
}

interface CacheFile {
  readonly fetchedAt: number;
  readonly data: unknown;
}

/** 第一方供应商优先:同一个 ID 在多家都有时,用原厂的名称和上限。 */
const PREFERRED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "xai",
  "mistral",
  "moonshotai",
  "alibaba",
  "minimax",
  "meta",
];

/** 官方 API 主机在 models.dev 里通常不写 `api` 字段,按主机名直接映射。 */
const OFFICIAL_HOST_PROVIDERS: Readonly<Record<string, string>> = {
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "generativelanguage.googleapis.com": "google",
  "api.deepseek.com": "deepseek",
  "api.x.ai": "xai",
  "api.mistral.ai": "mistral",
  "openrouter.ai": "openrouter",
  "api.moonshot.ai": "moonshotai",
  "api.moonshot.cn": "moonshotai-cn",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseModel(fallbackId: string, raw: unknown): ModelsDevModel | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : fallbackId;
  const limit = asRecord(record.limit);
  const modalities = asRecord(record.modalities);
  const input = Array.isArray(modalities?.input) ? modalities.input : undefined;
  const output = Array.isArray(modalities?.output) ? modalities.output : undefined;
  return {
    id,
    ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
    ...(positiveInt(limit?.context) ? { contextWindow: positiveInt(limit?.context) } : {}),
    ...(positiveInt(limit?.output) ? { maxOutput: positiveInt(limit?.output) } : {}),
    ...(input ? { vision: input.includes("image") } : {}),
    ...(typeof record.tool_call === "boolean" ? { tools: record.tool_call } : {}),
    ...(typeof record.reasoning === "boolean" ? { reasoning: record.reasoning } : {}),
    ...(typeof record.release_date === "string" ? { releaseDate: record.release_date } : {}),
    ...(output && !output.includes("text") ? { nonTextOutput: true } : {}),
  };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "").toLowerCase();
}

function urlCandidates(baseUrl: string): string[] {
  const normalized = normalizeUrl(baseUrl);
  const withoutV1 = normalized.replace(/\/v1$/u, "");
  return [...new Set([normalized, withoutV1, `${withoutV1}/v1`])];
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** models.dev JSON → 查询索引。宽松解析:单个条目格式不对只跳过该条目。 */
export function buildModelsDevCatalog(data: unknown): ModelsDevCatalog | null {
  const root = asRecord(data);
  if (!root) return null;
  const providers = new Map<string, { api?: string; models: ModelsDevModel[] }>();
  for (const [providerKey, rawProvider] of Object.entries(root)) {
    const provider = asRecord(rawProvider);
    const models = asRecord(provider?.models);
    if (!provider || !models) continue;
    const parsed = Object.entries(models).flatMap(([modelKey, rawModel]) => {
      const model = parseModel(modelKey, rawModel);
      return model ? [model] : [];
    });
    providers.set(providerKey, {
      ...(typeof provider.api === "string" ? { api: provider.api } : {}),
      models: parsed,
    });
  }
  if (providers.size === 0) return null;

  const orderedKeys = [
    ...PREFERRED_PROVIDERS.filter((key) => providers.has(key)),
    ...[...providers.keys()].filter((key) => !PREFERRED_PROVIDERS.includes(key)),
  ];
  const byId = new Map<string, ModelsDevModel>();
  for (const key of orderedKeys) {
    for (const model of providers.get(key)!.models) {
      const lower = model.id.toLowerCase();
      if (!byId.has(lower)) byId.set(lower, model);
    }
  }

  return {
    lookup(modelId) {
      const lower = modelId.trim().toLowerCase();
      const exact = byId.get(lower);
      if (exact) return exact;
      const slash = lower.lastIndexOf("/");
      return slash >= 0 ? byId.get(lower.slice(slash + 1)) : undefined;
    },
    modelsForBaseUrl(baseUrl) {
      const candidates = urlCandidates(baseUrl);
      for (const provider of providers.values()) {
        if (provider.api && candidates.includes(normalizeUrl(provider.api))) return provider.models;
      }
      const host = hostOf(baseUrl);
      if (!host) return [];
      const official = OFFICIAL_HOST_PROVIDERS[host];
      if (official && providers.has(official)) return providers.get(official)!.models;
      for (const provider of providers.values()) {
        if (provider.api && hostOf(provider.api) === host) return provider.models;
      }
      return [];
    },
  };
}

export function createModelsDevCatalogSource(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly cacheFilePath: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
}): ModelsDevCatalogSource {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let memory: { fetchedAt: number; catalog: ModelsDevCatalog } | null = null;
  let inflight: Promise<ModelsDevCatalog | null> | null = null;
  let lastFailureAt: number | null = null;

  const readCache = async (): Promise<CacheFile | null> => {
    try {
      const parsed = asRecord(JSON.parse(await readFile(options.cacheFilePath, "utf8")));
      if (!parsed || typeof parsed.fetchedAt !== "number") return null;
      return { fetchedAt: parsed.fetchedAt, data: parsed.data };
    } catch {
      return null;
    }
  };

  const writeCache = async (cache: CacheFile): Promise<void> => {
    try {
      await mkdir(dirname(options.cacheFilePath), { recursive: true });
      const temp = `${options.cacheFilePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(cache), "utf8");
      await rename(temp, options.cacheFilePath);
    } catch {
      // 缓存写不进去只影响下次启动要重新下载,不影响本次结果。
    }
  };

  const refresh = async (): Promise<ModelsDevCatalog | null> => {
    const cached = memory ? null : await readCache();
    if (!memory && cached) {
      const catalog = buildModelsDevCatalog(cached.data);
      if (catalog) memory = { fetchedAt: cached.fetchedAt, catalog };
    }
    if (memory && now() - memory.fetchedAt < ttlMs) return memory.catalog;
    try {
      const response = await options.fetch(MODELS_DEV_API_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      const catalog = buildModelsDevCatalog(data);
      if (!catalog) throw new Error("models.dev 返回内容无法解析");
      const fetchedAt = now();
      memory = { fetchedAt, catalog };
      await writeCache({ fetchedAt, data });
      return catalog;
    } catch {
      lastFailureAt = now();
      // 离线或被墙时用过期缓存;目录只是锦上添花,拿不到就让调用方走 ID 美化兜底。
      return memory?.catalog ?? null;
    }
  };

  return {
    load() {
      if (memory && now() - memory.fetchedAt < ttlMs) return Promise.resolve(memory.catalog);
      if (lastFailureAt !== null && now() - lastFailureAt < FAILURE_BACKOFF_MS) {
        return Promise.resolve(memory?.catalog ?? null);
      }
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
