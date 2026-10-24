import {
  decodeCloakedModelId,
  isLikelyNonChatModel,
  prettifyModelId,
  type DiscoveredModel,
  type ModelDiscoveryApiFormat,
  type ModelDiscoveryErrorKind,
  type ModelDiscoveryResult,
} from "@zcode/shared/model-discovery";
import type { ModelsDevCatalog, ModelsDevCatalogSource } from "./modelsDevCatalog.js";

/**
 * [leo] 「从接口获取模型」:在 Host(Node)里按供应商的 Base URL + Key 列出可用模型。
 *
 * 规则(与 docs/specs/leo-model-discovery.md 一致):
 * - OpenAI 格式:GET {base}/models,有 Key 才带 Bearer;base 不含 /v1 且 404 时再试 {base}/v1/models。
 * - Anthropic:GET {normalize(base)}/models?limit=1000,x-api-key + anthropic-version,
 *   非官方主机另带 Bearer;按 has_more/last_id 翻页。很多 /anthropic 兼容网关没有这个接口,
 *   404 / HTML / 非 JSON 时再试 OpenAI 风格的 {origin}/v1/models。
 * - 401/403 直接报 auth,不回退(回退会让用户以为 Key 没问题)。
 * - 404 / HTML / 解析失败 / 空列表:回退到模板内置列表,再回退 models.dev,error.kind = not_supported。
 * - 网络 / TLS 错误照实报告;有内置列表时一并带回,方便用户先选。
 * - CLIProxyAPI 在 Anthropic 风格列表里把非 Claude 模型伪装成 `claude-…-dd-<倒序 ID>`,入库前还原。
 */
export interface ModelDiscoveryTarget {
  readonly baseUrl: string;
  readonly apiFormat: ModelDiscoveryApiFormat;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** 模板/供应商自带的内置模型 ID,接口不支持列模型时的第一兜底。 */
  readonly builtinModelIds?: readonly string[];
}

export type ProviderModelDiscoverer = (
  target: ModelDiscoveryTarget,
) => Promise<ModelDiscoveryResult>;

export interface ProviderModelDiscoveryDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly catalog?: ModelsDevCatalogSource;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ANTHROPIC_PAGES = 10;

interface RawModel {
  readonly id: string;
  readonly displayName?: string;
}

type Attempt =
  | { readonly ok: true; readonly models: RawModel[] }
  | {
      readonly ok: false;
      /** not_found:404/405;bad_body:HTML、非 JSON 或结构不对。 */
      readonly reason: "auth" | "not_found" | "bad_body" | "http" | "network" | "tls";
      readonly message: string;
    };

export function createProviderModelDiscoverer(
  dependencies: ProviderModelDiscoveryDependencies,
): ProviderModelDiscoverer {
  return (target) => discoverProviderModels(target, dependencies);
}

export async function discoverProviderModels(
  target: ModelDiscoveryTarget,
  dependencies: ProviderModelDiscoveryDependencies,
): Promise<ModelDiscoveryResult> {
  const baseUrl = target.baseUrl.trim().replace(/\/+$/u, "");
  const catalogPromise = dependencies.catalog?.load().catch(() => null) ?? Promise.resolve(null);
  let attempt: Attempt;
  try {
    new URL(baseUrl);
    attempt =
      target.apiFormat === "anthropic-messages"
        ? await fetchAnthropicModels(baseUrl, target, dependencies)
        : await fetchOpenAIModels(baseUrl, target, dependencies);
  } catch (error) {
    attempt = { ok: false, reason: "network", message: describeError(error) };
  }
  const catalog = await catalogPromise;

  if (attempt.ok && attempt.models.length > 0) {
    return { models: enrichModels(attempt.models, catalog), source: "endpoint" };
  }
  if (!attempt.ok && attempt.reason === "auth") {
    return { models: [], source: "endpoint", error: { kind: "auth", message: attempt.message } };
  }
  const kind: ModelDiscoveryErrorKind = attempt.ok
    ? "not_supported"
    : attempt.reason === "not_found" || attempt.reason === "bad_body"
      ? "not_supported"
      : attempt.reason === "network" || attempt.reason === "tls"
        ? attempt.reason
        : "unknown";
  const message = attempt.ok ? "empty model list" : attempt.message;
  const builtin = uniqueIds(target.builtinModelIds ?? []);
  if (builtin.length > 0) {
    return {
      models: enrichModels(
        builtin.map((id) => ({ id })),
        catalog,
      ),
      source: "builtin",
      error: { kind, message },
    };
  }
  const catalogModels = catalog?.modelsForBaseUrl(baseUrl) ?? [];
  if (catalogModels.length > 0) {
    return {
      models: enrichModels(
        catalogModels.map((model) => ({ id: model.id })),
        catalog,
      ),
      source: "catalog",
      error: { kind, message },
    };
  }
  return { models: [], source: "builtin", error: { kind, message } };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function enrichModels(
  raw: readonly RawModel[],
  catalog: ModelsDevCatalog | null,
): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of raw) {
    const id = decodeCloakedModelId(item.id.trim());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = catalog?.lookup(id);
    const capabilities = entry
      ? {
          ...(entry.vision === undefined ? {} : { vision: entry.vision }),
          ...(entry.tools === undefined ? {} : { tools: entry.tools }),
          ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
        }
      : undefined;
    models.push({
      id,
      displayName: entry?.name || item.displayName?.trim() || prettifyModelId(id),
      ...(entry?.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry?.maxOutput ? { maxOutput: entry.maxOutput } : {}),
      ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      ...(entry?.releaseDate ? { releaseDate: entry.releaseDate } : {}),
      ...(isLikelyNonChatModel(id) || entry?.nonTextOutput ? { hidden: true } : {}),
    });
  }
  return models;
}

function withCustomHeaders(
  target: ModelDiscoveryTarget,
  headers: Record<string, string>,
): Record<string, string> {
  // 与运行时一致:用户在供应商里显式配置的同名头(如自定义 Authorization)优先。
  const custom = target.headers ?? {};
  const customNames = new Set(Object.keys(custom).map((name) => name.toLowerCase()));
  const own = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !customNames.has(name.toLowerCase())),
  );
  return { accept: "application/json", ...own, ...custom };
}

function bearer(apiKey: string | undefined): Record<string, string> {
  const key = apiKey?.trim();
  // 本机 Ollama / LM Studio 不需要 Key:没有 Key 就完全不带鉴权头。
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function hasV1Suffix(url: string): boolean {
  try {
    return /\/v1$/iu.test(new URL(url).pathname.replace(/\/+$/u, ""));
  } catch {
    return /\/v1$/iu.test(url);
  }
}

async function fetchOpenAIModels(
  baseUrl: string,
  target: ModelDiscoveryTarget,
  dependencies: ProviderModelDiscoveryDependencies,
): Promise<Attempt> {
  const headers = withCustomHeaders(target, bearer(target.apiKey));
  const first = await requestModelList(`${baseUrl}/models`, headers, dependencies);
  if (!first.ok && first.reason === "not_found" && !hasV1Suffix(baseUrl)) {
    const retry = await requestModelList(`${baseUrl}/v1/models`, headers, dependencies);
    return retry.ok || retry.reason !== "not_found" ? retry : first;
  }
  return first;
}

async function fetchAnthropicModels(
  baseUrl: string,
  target: ModelDiscoveryTarget,
  dependencies: ProviderModelDiscoveryDependencies,
): Promise<Attempt> {
  const apiKey = target.apiKey?.trim();
  const official = isOfficialAnthropicHost(baseUrl);
  const headers = withCustomHeaders(target, {
    "anthropic-version": ANTHROPIC_VERSION,
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    // 兼容网关常只认 Bearer;官方接口只认 x-api-key,不重复带。
    ...(official ? {} : bearer(apiKey)),
  });
  const root = normalizeAnthropicBaseUrl(baseUrl);
  const models: RawModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page += 1) {
    const url = new URL(`${root}/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const result = await requestModelList(url.href, headers, dependencies);
    if (!result.ok) {
      if (page > 0) break;
      if (result.reason === "not_found" || result.reason === "bad_body") {
        // /anthropic 兼容网关大多没有 Anthropic 的列模型接口,但同源的 OpenAI 风格接口常常可用。
        const fallback = await requestModelList(
          `${new URL(baseUrl).origin}/v1/models`,
          withCustomHeaders(target, bearer(apiKey)),
          dependencies,
        );
        return fallback.ok || fallback.reason === "auth" ? fallback : result;
      }
      return result;
    }
    models.push(...result.models);
    if (!result.hasMore || !result.lastId) break;
    afterId = result.lastId;
  }
  return { ok: true, models };
}

function isOfficialAnthropicHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** 与 Agent 运行时(adapters/model-execution.ts normalizeAnthropicBaseURL)同一规则:补齐 /v1。 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    url.pathname = pathname.toLowerCase().endsWith("/v1") ? pathname : `${pathname}/v1`;
    return url.href.replace(/\/+$/u, "");
  } catch {
    const withoutSlash = trimmed.replace(/\/+$/u, "");
    return withoutSlash.toLowerCase().endsWith("/v1") ? withoutSlash : `${withoutSlash}/v1`;
  }
}

type ListAttempt =
  | { readonly ok: true; readonly models: RawModel[]; hasMore?: boolean; lastId?: string }
  | Extract<Attempt, { ok: false }>;

async function requestModelList(
  url: string,
  headers: Record<string, string>,
  dependencies: ProviderModelDiscoveryDependencies,
): Promise<ListAttempt> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: isTlsError(error) ? "tls" : "network",
      message: describeError(error),
    };
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "auth", message: `HTTP ${response.status}` };
  }
  if (response.status === 404 || response.status === 405) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "not_found", message: `HTTP ${response.status}` };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, reason: "network", message: describeError(error) };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const looksHtml = /text\/html/iu.test(contentType) || /^\s*</u.test(text);
  if (!response.ok) {
    // 有的网关对未知路径返回 200/500 + HTML 首页,也当作「不支持」。
    return looksHtml
      ? { ok: false, reason: "bad_body", message: `HTTP ${response.status} (HTML)` }
      : { ok: false, reason: "http", message: `HTTP ${response.status}` };
  }
  if (looksHtml) return { ok: false, reason: "bad_body", message: "HTML response" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad_body", message: "invalid JSON" };
  }
  const parsed = parseModelListBody(body);
  if (!parsed) return { ok: false, reason: "bad_body", message: "unexpected response shape" };
  return { ok: true, ...parsed };
}

/** 兼容 `{data:[{id}]}`(OpenAI/Anthropic)、`{models:[{name}]}`(Ollama 原生)与裸数组。 */
export function parseModelListBody(
  body: unknown,
): { models: RawModel[]; hasMore?: boolean; lastId?: string } | null {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const list = Array.isArray(body)
    ? body
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : undefined;
  if (!list) return null;
  const models = list.flatMap((item): RawModel[] => {
    if (typeof item === "string") return item.trim() ? [{ id: item.trim() }] : [];
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const id =
      typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
    if (!id.trim()) return [];
    const displayName =
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : undefined;
    return [{ id: id.trim(), ...(displayName ? { displayName } : {}) }];
  });
  return {
    models,
    ...(record?.has_more === true ? { hasMore: true } : {}),
    ...(typeof record?.last_id === "string" ? { lastId: record.last_id } : {}),
  };
}

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function errorChain(error: unknown): Array<{ code?: unknown; message?: unknown; name?: unknown }> {
  const chain: Array<{ code?: unknown; message?: unknown; name?: unknown }> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    chain.push(current as { code?: unknown; message?: unknown; name?: unknown });
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isTlsError(error: unknown): boolean {
  return errorChain(error).some(
    (item) =>
      (typeof item.code === "string" && TLS_ERROR_CODES.has(item.code)) ||
      (typeof item.message === "string" && /certificate|ssl|tls/iu.test(item.message)),
  );
}

function describeError(error: unknown): string {
  const chain = errorChain(error);
  if (chain.some((item) => item.name === "TimeoutError" || item.name === "AbortError")) {
    return "timeout";
  }
  const coded = chain.find((item) => typeof item.code === "string");
  const deepest = chain.at(-1);
  const message = typeof deepest?.message === "string" ? deepest.message : String(error);
  return typeof coded?.code === "string" ? `${coded.code}: ${message}` : message;
}
