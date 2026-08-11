import crypto from 'node:crypto';

import { providerModelCachePath } from './provider-switch.config.js';
import { normalizeEndpointUrls, normalizeWireApi } from './provider-store.service.js';
import type { SwitchProvider } from './provider-store.service.js';
import { readJsonFile, safeText, writeJsonFile } from './provider-switch.storage.js';


type StatusError = Error & { statusCode?: number; details?: Record<string, unknown> };
type DiscoveryResult = { models: string[]; latencyMs: number; httpStatus: number; endpoint: string };
type DiscoveryCacheEntry = { updatedAt: number; expiresAt: number; result: DiscoveryResult };
type DiscoveryCacheFile = { version: number; entries: Record<string, DiscoveryCacheEntry> };
type DiscoveryCacheInfo = { source: string; updatedAt: string; expiresAt: string };
type DiscoveryResponse = DiscoveryResult & { cache: DiscoveryCacheInfo };
type DiscoveryOptions = { baseUrl?: unknown; bypassCache?: boolean; timeoutMs?: unknown };
type BenchmarkOptions = { model?: unknown; attempts?: unknown; timeoutMs?: unknown };
type EndpointOptions = { endpoints?: unknown; timeoutMs?: unknown };
type Probe = { url: string; method?: string; headers: Record<string, string>; body?: string | Record<string, unknown> };
type BenchmarkResultRow = { attempt: number; ok: boolean; latencyMs: number; httpStatus: number | null; error: string | null };
type EndpointResult = { url: string; reachable: boolean; usable: boolean; latencyMs: number; httpStatus: number | null; authStatus: string; note: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

const MODEL_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const modelDiscoveryCache = new Map<string, DiscoveryCacheEntry>();
const pendingModelDiscoveries = new Map<string, Promise<DiscoveryResponse>>();
let modelCacheMutationQueue: Promise<unknown> = Promise.resolve();

function modelDiscoveryCacheKey(provider: SwitchProvider, rawBase: string): string {
  const apiKeyFingerprint = crypto.createHash('sha256').update(String(provider.apiKey || '')).digest('hex').slice(0, 16);
  return crypto.createHash('sha256').update(JSON.stringify({
    target: provider.target,
    baseUrl: safeText(rawBase, 800).replace(/\/+$/, ''),
    wireApi: normalizeWireApi(provider.wireApi),
    apiKeyFingerprint,
  })).digest('hex');
}

function isValidModelDiscoveryCacheEntry(entry: unknown, now = Date.now()): entry is DiscoveryCacheEntry {
  const candidate = asRecord(entry);
  return Boolean(
    Number.isFinite(candidate.updatedAt)
    && Number.isFinite(candidate.expiresAt)
    && Number(candidate.updatedAt) > 0
    && Number(candidate.expiresAt) > now
    && Array.isArray(asRecord(candidate.result).models),
  );
}

function modelDiscoveryCacheInfo(entry: DiscoveryCacheEntry, source: string): DiscoveryCacheInfo {
  return {
    source,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

async function loadModelDiscoveryDiskCache(): Promise<Record<string, DiscoveryCacheEntry>> {
  const value = await readJsonFile<DiscoveryCacheFile>(providerModelCachePath(), { version: 2, entries: {} });
  if (value?.version !== 2 || !value.entries || typeof value.entries !== 'object') return {};
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(value.entries).filter(([, entry]) => isValidModelDiscoveryCacheEntry(entry, now)),
  );
}

function withModelCacheMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = modelCacheMutationQueue.then(operation, operation);
  modelCacheMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function persistModelDiscoveryCache(): Promise<void> {
  await withModelCacheMutation(async () => {
    const now = Date.now();
    const diskEntries = await loadModelDiscoveryDiskCache();
    const mergedEntries = new Map(Object.entries(diskEntries));
    for (const [key, entry] of modelDiscoveryCache.entries()) {
      if (isValidModelDiscoveryCacheEntry(entry, now)) mergedEntries.set(key, entry);
      else mergedEntries.delete(key);
    }
    const entries = Object.fromEntries(
      [...mergedEntries.entries()].filter(([, entry]) => isValidModelDiscoveryCacheEntry(entry, now)),
    );
    await writeJsonFile(providerModelCachePath(), { version: 2, entries });
  });
}






function appendApiPath(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(base) && suffix.startsWith('/v1/')) {
    return `${base}${suffix.slice(3)}`;
  }
  return `${base}${suffix}`;
}

function buildProviderProbe(provider: SwitchProvider, rawBase: string): Probe {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'leocodebox-connectivity-check',
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url: appendApiPath(rawBase, '/v1/messages'),
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model || 'claude-sonnet-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
    };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, '/models'));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return { url: url.toString(), method: 'GET', headers };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions|models)\/?$/i, '');
  return { url: appendApiPath(base, '/models'), method: 'GET', headers };
}

function providerProbeNote(response: Response): { authStatus: string; note: string } {
  if (response.ok) return { authStatus: 'accepted', note: '端点可达且认证通过。' };
  if (response.status === 401 || response.status === 403) {
    return { authStatus: 'rejected', note: `端点可达（HTTP ${response.status}），但凭据被拒绝。` };
  }
  if (response.status === 429) {
    return { authStatus: 'accepted', note: '端点可达且凭据未被拒绝，但当前请求受到限流。' };
  }
  if ([400, 422].includes(response.status)) {
    return { authStatus: 'accepted', note: `端点可达且凭据未被拒绝（HTTP ${response.status}），请检查模型名称或请求参数。` };
  }
  if ([404, 405].includes(response.status)) {
    return { authStatus: 'unknown', note: `端点可达（HTTP ${response.status}），但接口路径或协议不匹配。` };
  }
  if (response.status >= 500) {
    return { authStatus: 'unknown', note: `端点可达，但上游服务异常（HTTP ${response.status}）。` };
  }
  return { authStatus: 'unknown', note: `端点可达（HTTP ${response.status}）。` };
}

// Protocol-aware reachability, credential and latency probe. It sends at most
// one token for Anthropic-compatible endpoints when the upstream accepts it.
async function testProviderConnectivity(provider: SwitchProvider) {
  const rawBase = safeText(provider.baseUrl, 800);
  if (!rawBase) {
    return { reachable: false, latencyMs: null, httpStatus: null, note: '未配置 Base URL，无法测试连通性。' };
  }

  const validatedBase = validateProviderBaseUrl(rawBase);
  const probe = buildProviderProbe(provider, validatedBase);

  const startedAt = Date.now();
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: typeof probe.body === 'string' ? probe.body : probe.body ? JSON.stringify(probe.body) : undefined,
      // Do not follow redirects: prevents a provider baseUrl from bouncing the
      // attached API key to a different host.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - startedAt;
    const assessment = providerProbeNote(response);
    return {
      reachable: true,
      latencyMs,
      httpStatus: response.status,
      authStatus: assessment.authStatus,
      note: assessment.note,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      authStatus: 'unknown',
      note: isTimeoutError(error) ? '连接超时（8 秒）。' : `无法连接：${errorMessage(error) || '未知错误'}`,
    };
  }
}

function parseBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function validateProviderBaseUrl(rawBase: string): string {
  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch {
    const error: StatusError = new Error('请求地址不是有效 URL。');
    error.statusCode = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error: StatusError = new Error('请求地址仅支持 HTTP 或 HTTPS 协议。');
    error.statusCode = 400;
    throw error;
  }
  return parsed.toString().replace(/\/$/, '');
}

function buildModelListProbe(provider: SwitchProvider, rawBase: string): Probe {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'leocodebox-model-discovery',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return { url: appendApiPath(rawBase, '/v1/models'), headers };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, '/v1beta/models'));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return { url: url.toString(), headers };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions|models)\/?$/i, '');
  return { url: appendApiPath(base, '/models'), headers };
}

function extractModelIds(payload: unknown): string[] {
  const source = asRecord(payload);
  const rows: unknown[] = Array.isArray(source.data)
    ? source.data
    : Array.isArray(source.models) ? source.models : Array.isArray(payload) ? payload : [];
  const models: string[] = [];
  for (const row of rows) {
    const rowRecord = asRecord(row);
    const rawId = typeof row === 'string' ? row : rowRecord.id || rowRecord.name || rowRecord.model;
    const id = safeText(rawId, 240).replace(/^models\//, '');
    if (id && !models.includes(id)) models.push(id);
    if (models.length >= 300) break;
  }
  return models.sort((left, right) => left.localeCompare(right));
}

async function discoverProviderModels(provider: SwitchProvider, options: DiscoveryOptions = {}): Promise<DiscoveryResponse> {
  const rawBase = safeText(options.baseUrl || provider.baseUrl, 800);
  if (!rawBase) {
    const error: StatusError = new Error('请先填写请求地址。');
    error.statusCode = 400;
    throw error;
  }
  const validatedBase = validateProviderBaseUrl(rawBase);
  const cacheKey = modelDiscoveryCacheKey(provider, validatedBase);
  const now = Date.now();
  if (!options.bypassCache) {
    const memoryEntry = modelDiscoveryCache.get(cacheKey);
    if (memoryEntry && memoryEntry.expiresAt > now) {
      return { ...memoryEntry.result, cache: modelDiscoveryCacheInfo(memoryEntry, 'memory') };
    }
    const diskEntries = await loadModelDiscoveryDiskCache();
    const diskEntry = diskEntries[cacheKey];
    if (diskEntry?.expiresAt > now && Array.isArray(diskEntry.result?.models)) {
      modelDiscoveryCache.set(cacheKey, diskEntry);
      return { ...diskEntry.result, cache: modelDiscoveryCacheInfo(diskEntry, 'disk') };
    }
  }
  const pending = pendingModelDiscoveries.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
    const probe = buildModelListProbe(provider, validatedBase);
    const startedAt = Date.now();
    const response = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const payloadRecord = asRecord(payload);
      const message = safeText(asRecord(payloadRecord.error).message || payloadRecord.message, 300);
      const error: StatusError = new Error(message || `模型列表读取失败（HTTP ${response.status}）。`);
      error.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
      error.details = { latencyMs, httpStatus: response.status };
      throw error;
    }
    const result = {
      models: extractModelIds(payload),
      latencyMs,
      httpStatus: response.status,
      endpoint: validatedBase,
    };
    const entry = {
      updatedAt: Date.now(),
      expiresAt: Date.now() + MODEL_DISCOVERY_CACHE_TTL_MS,
      result,
    };
    modelDiscoveryCache.set(cacheKey, entry);
    try {
      await persistModelDiscoveryCache();
    } catch (error) {
      console.warn('Unable to persist model discovery cache:', error);
    }
    return { ...result, cache: modelDiscoveryCacheInfo(entry, 'fresh') };
  })().finally(() => pendingModelDiscoveries.delete(cacheKey));
  pendingModelDiscoveries.set(cacheKey, request);
  return request;
}

function buildModelBenchmarkProbe(provider: SwitchProvider, model: string): Probe {
  const rawBase = safeText(provider.baseUrl, 800);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'leocodebox-model-benchmark',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  if (provider.target === 'claude') {
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    return {
      url: appendApiPath(rawBase, '/v1/messages'),
      headers,
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply with OK.' }] },
    };
  }

  if (provider.target === 'gemini' && /generativelanguage\.googleapis\.com/i.test(rawBase)) {
    const url = new URL(appendApiPath(rawBase, `/v1beta/models/${encodeURIComponent(model)}:generateContent`));
    if (provider.apiKey) url.searchParams.set('key', provider.apiKey);
    delete headers.Authorization;
    return {
      url: url.toString(),
      headers,
      body: { contents: [{ parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 1 } },
    };
  }

  const base = rawBase.replace(/\/(?:responses|chat\/completions)\/?$/i, '');
  if (provider.wireApi === 'responses') {
    return {
      url: appendApiPath(base, '/responses'),
      headers,
      body: { model, input: 'Reply with OK.', max_output_tokens: 1 },
    };
  }
  return {
    url: appendApiPath(base, '/chat/completions'),
    headers,
    body: { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 },
  };
}

async function benchmarkProviderModel(provider: SwitchProvider, options: BenchmarkOptions = {}) {
  const model = safeText(options.model || provider.model, 240);
  if (!provider.baseUrl || !model) {
    const error: StatusError = new Error('测速前需要填写请求地址和模型名称。');
    error.statusCode = 400;
    throw error;
  }
  validateProviderBaseUrl(provider.baseUrl);
  const attempts = parseBoundedInteger(options.attempts, 1, 1, 5);
  const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
  const results: BenchmarkResultRow[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = buildModelBenchmarkProbe(provider, model);
    const startedAt = Date.now();
    try {
      const response = await fetch(probe.url, {
        method: 'POST',
        headers: probe.headers,
        body: JSON.stringify(probe.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      results.push({
        attempt,
        ok: response.ok,
        latencyMs,
        httpStatus: response.status,
        error: response.ok ? null : safeText(asRecord(asRecord(payload).error).message || asRecord(payload).message || `HTTP ${response.status}`, 300),
      });
    } catch (error) {
      results.push({
        attempt,
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: null,
        error: isTimeoutError(error) ? `超过 ${timeoutMs} ms` : safeText(errorMessage(error) || '连接失败', 300),
      });
    }
  }
  const successful = results.filter((result) => result.ok);
  const latencies = successful.map((result) => result.latencyMs);
  return {
    model,
    attempts,
    successCount: successful.length,
    averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    minimumLatencyMs: latencies.length ? Math.min(...latencies) : null,
    maximumLatencyMs: latencies.length ? Math.max(...latencies) : null,
    results,
  };
}

async function testProviderEndpoints(provider: SwitchProvider, options: EndpointOptions = {}): Promise<EndpointResult[]> {
  const endpoints = normalizeEndpointUrls(
    { endpoints: Array.isArray(options.endpoints) ? options.endpoints : provider.endpoints },
    provider,
    provider.baseUrl,
  );
  const timeoutMs = parseBoundedInteger(options.timeoutMs, 8000, 1000, 30000);
  const results: EndpointResult[] = [];
  for (const endpoint of endpoints) {
    const validatedEndpoint = validateProviderBaseUrl(endpoint);
    const probe = buildModelListProbe(provider, validatedEndpoint);
    const startedAt = Date.now();
    try {
      const response = await fetch(probe.url, {
        method: 'GET',
        headers: probe.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const assessment = providerProbeNote(response);
      results.push({
        url: endpoint,
        reachable: true,
        usable: assessment.authStatus !== 'rejected' && response.status < 500 && ![404, 405].includes(response.status),
        latencyMs: Date.now() - startedAt,
        httpStatus: response.status,
        authStatus: assessment.authStatus,
        note: assessment.note,
      });
    } catch (error) {
      results.push({
        url: endpoint,
        reachable: false,
        usable: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: null,
        authStatus: 'unknown',
        note: isTimeoutError(error) ? `超过 ${timeoutMs} ms` : safeText(errorMessage(error) || '连接失败', 300),
      });
    }
  }
  return results;
}



export type ProviderHealthProbe = {
  ok: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  note: string;
};

/**
 * Cost-free health probe for background polling. Unlike
 * testProviderConnectivity (whose claude branch POSTs a paid 1-token message),
 * this always uses the GET model-list endpoint, so a 5-minute poll never
 * spends tokens. Classification is deliberately forgiving: only credential
 * rejection (401/403), upstream 5xx, network errors and timeouts count as
 * unhealthy — 404/405 on /models (common on relays) is still "alive".
 */
async function probeProviderHealth(provider: SwitchProvider): Promise<ProviderHealthProbe> {
  const rawBase = safeText(provider.baseUrl, 800);
  if (!rawBase) {
    return { ok: false, latencyMs: null, httpStatus: null, note: '未配置 Base URL。' };
  }
  const startedAt = Date.now();
  try {
    // Inside the try on purpose: imported providers can carry an invalid
    // baseUrl, and a background poll must classify that as "unhealthy", not
    // throw into the caller's loop.
    const validatedBase = validateProviderBaseUrl(rawBase);
    const probe = buildModelListProbe(provider, validatedBase);
    const response = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers,
      // Same key-safety stance as every other probe: never follow redirects.
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    // Release the connection: an unconsumed body pins its keep-alive socket,
    // and this probe runs on a periodic schedule.
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup only.
    }
    const latencyMs = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, latencyMs, httpStatus: response.status, note: `凭据被拒绝（HTTP ${response.status}）。` };
    }
    if (response.status >= 500) {
      return { ok: false, latencyMs, httpStatus: response.status, note: `上游服务异常（HTTP ${response.status}）。` };
    }
    return { ok: true, latencyMs, httpStatus: response.status, note: '探测通过。' };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      note: isTimeoutError(error) ? '连接超时（8 秒）。' : `无法连接：${errorMessage(error) || '未知错误'}`,
    };
  }
}

export {
  benchmarkProviderModel,
  discoverProviderModels,
  parseBoundedInteger,
  probeProviderHealth,
  testProviderConnectivity,
  testProviderEndpoints,
  validateProviderBaseUrl,
};
