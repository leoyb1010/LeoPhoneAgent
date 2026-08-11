import crypto from 'node:crypto';

import { decryptProviderSecret, encryptProviderSecret } from './provider-secrets.service.js';
import { providerStorePath, switchDir, TARGETS } from './provider-switch.config.js';
import { ensureDir, nowIso, readJsonFile, safeText, writeJsonFile } from './provider-switch.storage.js';


type WireApi = 'responses' | 'chat';
type ProviderEndpoint = string | { url?: unknown };
type ProviderModelMapping = { sonnet: string; opus: string; haiku: string };
export type SwitchProvider = {
  id: string;
  target: string;
  name: string;
  baseUrl: string;
  endpoints: string[];
  /** Optional human nicknames keyed by normalized endpoint URL（如「家里光猫」）. */
  endpointLabels: Record<string, string>;
  autoSelectEndpoint: boolean;
  endpointStats: Record<string, unknown>;
  apiKey: string;
  model: string;
  discoveredModels: string[];
  modelDiscovery: Record<string, unknown> | null;
  modelDiscoveryError: string;
  modelMapping: ProviderModelMapping;
  wireApi: WireApi;
  notes: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
  source: string;
};
export type SwitchProviderInput = Partial<Omit<SwitchProvider, 'endpoints' | 'modelMapping'>> & {
  endpoints?: ProviderEndpoint[];
  modelMapping?: Partial<ProviderModelMapping>;
};
/** Persisted background health-monitor preferences (see provider-health.service). */
export type HealthMonitorSettings = {
  enabled: boolean;
  intervalMinutes: number;
  /** Targets where a degraded active provider may be auto-switched to a healthy sibling. */
  autoFailoverTargets: string[];
};
/**
 * One routing-slot binding: which provider (and optional model override) a
 * scenario slot resolves to. Empty/missing binding falls back to activeByTarget.
 */
export type RoutingSlotBinding = { providerId: string; model?: string };
/** routingSlots[target][slotId] → binding. Slots are optional; absent = legacy single-active behavior. */
export type RoutingSlots = Record<string, Record<string, RoutingSlotBinding>>;
export type ProviderStore = {
  providers: SwitchProvider[];
  activeByTarget: Record<string, string>;
  healthMonitor: HealthMonitorSettings;
  routingSlots: RoutingSlots;
};
type StatusError = Error & { statusCode?: number };

let switchMutationQueue: Promise<unknown> = Promise.resolve();

export function normalizeTarget(target: unknown): string | null {
  const normalized = safeText(target).toLowerCase();
  return TARGETS[normalized] ? normalized : null;
}

export function normalizeWireApi(wireApi: unknown): WireApi {
  return wireApi === 'responses' || wireApi === 'chat' ? wireApi : 'responses';
}

export function sanitizeIdPart(value: unknown): string {
  const cleaned = safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'provider';
}

function redactSecret(value: unknown): string {
  const text = safeText(value, 500);
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

export function sanitizeProvider(provider: SwitchProvider): Omit<SwitchProvider, 'apiKey'> & { apiKey: string; hasApiKey: boolean } {
  return { ...provider, apiKey: provider.apiKey ? redactSecret(provider.apiKey) : '', hasApiKey: Boolean(provider.apiKey) };
}

export function normalizeEndpointUrls(input: SwitchProviderInput, existing: SwitchProvider | null, baseUrl: string): string[] {
  const source = Array.isArray(input?.endpoints)
    ? input.endpoints
    : Array.isArray(existing?.endpoints) ? existing.endpoints : [];
  const urls: string[] = [];
  for (const endpoint of source) {
    const url = safeText(typeof endpoint === 'string' ? endpoint : endpoint?.url, 800).replace(/\/+$/, '');
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 20) break;
  }
  const normalizedBase = safeText(baseUrl, 800).replace(/\/+$/, '');
  if (normalizedBase && !urls.includes(normalizedBase)) urls.unshift(normalizedBase);
  return urls;
}

export function normalizeEndpointLabels(input: SwitchProviderInput, existing: SwitchProvider | null): Record<string, string> {
  const source = input?.endpointLabels && typeof input.endpointLabels === 'object'
    ? input.endpointLabels
    : existing?.endpointLabels && typeof existing.endpointLabels === 'object' ? existing.endpointLabels : {};
  const labels: Record<string, string> = {};
  for (const [rawUrl, rawLabel] of Object.entries(source)) {
    const url = safeText(rawUrl, 800).replace(/\/+$/, '');
    const label = safeText(rawLabel, 60);
    if (url && label) labels[url] = label;
    if (Object.keys(labels).length >= 20) break;
  }
  return labels;
}

export function normalizeModelMapping(input: SwitchProviderInput, existing: SwitchProvider | null, fallbackModel: string): ProviderModelMapping {
  const source = input?.modelMapping && typeof input.modelMapping === 'object'
    ? input.modelMapping
    : existing?.modelMapping && typeof existing.modelMapping === 'object' ? existing.modelMapping : {};
  return {
    sonnet: safeText(source.sonnet || fallbackModel, 240),
    opus: safeText(source.opus || fallbackModel, 240),
    haiku: safeText(source.haiku || fallbackModel, 240),
  };
}

export function normalizeProvider(input: SwitchProviderInput, existing: SwitchProvider | null = null): SwitchProvider {
  const target = normalizeTarget(input?.target || existing?.target);
  if (!target) {
    const error: StatusError = new Error('Unsupported provider target.');
    error.statusCode = 400;
    throw error;
  }
  const name = safeText(input?.name || existing?.name || TARGETS[target].label, 120);
  const id = safeText(input?.id || existing?.id || `${target}-${crypto.randomUUID()}`, 90);
  const currentApiKey = existing?.apiKey || '';
  const nextApiKey = input?.apiKey === '__KEEP__' ? currentApiKey : safeText(input?.apiKey ?? currentApiKey, 4000);
  const baseUrl = safeText(input?.baseUrl ?? existing?.baseUrl ?? '', 800).replace(/\/+$/, '');
  const model = safeText(input?.model ?? existing?.model ?? '', 200);
  return {
    id,
    target,
    name,
    baseUrl,
    endpoints: normalizeEndpointUrls(input, existing, baseUrl),
    endpointLabels: normalizeEndpointLabels(input, existing),
    autoSelectEndpoint: typeof input?.autoSelectEndpoint === 'boolean' ? input.autoSelectEndpoint : Boolean(existing?.autoSelectEndpoint),
    endpointStats: existing?.endpointStats && typeof existing.endpointStats === 'object' ? existing.endpointStats : {},
    apiKey: nextApiKey,
    model,
    discoveredModels: Array.isArray(existing?.discoveredModels)
      ? existing.discoveredModels.map((item) => safeText(item, 240)).filter(Boolean).slice(0, 300)
      : [],
    modelDiscovery: existing?.modelDiscovery && typeof existing.modelDiscovery === 'object' ? existing.modelDiscovery : null,
    modelDiscoveryError: safeText(existing?.modelDiscoveryError ?? '', 500),
    modelMapping: normalizeModelMapping(input, existing, model),
    wireApi: normalizeWireApi(input?.wireApi ?? existing?.wireApi),
    notes: safeText(input?.notes ?? existing?.notes ?? '', 2000),
    category: safeText(input?.category ?? existing?.category ?? 'custom', 80),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    source: 'leocodebox-switch',
  };
}

export const ENDPOINT_HISTORY_LIMIT = 20;

/** One persisted latency sample kept in an endpoint's rolling history. */
export type EndpointStatSample = {
  latencyMs: number;
  usable: boolean;
  httpStatus: number | null;
  testedAt: string;
};

/**
 * Per-endpoint speed-test record. Top-level fields mirror the latest sample so
 * existing readers (switch.html statFor, useLeoapiStatus, useLeoapiSwitchSource)
 * keep working unchanged; `history` is the new rolling buffer for sparklines.
 */
export type EndpointStatEntry = {
  schemaVersion: 1;
  latencyMs: number;
  httpStatus: number | null;
  authStatus: string;
  usable: boolean;
  testedAt: string;
  history: EndpointStatSample[];
};

type EndpointTestResult = {
  url: string;
  latencyMs: number;
  httpStatus: number | null;
  authStatus: string;
  usable: boolean;
};

/**
 * Fold a fresh round of endpoint test results into the stored stats, appending
 * each to a rolling history capped at ENDPOINT_HISTORY_LIMIT. Tolerates legacy
 * flat records (no schemaVersion/history) by treating their history as empty.
 */
export function appendEndpointSamples(
  prevStats: Record<string, unknown> | null | undefined,
  results: EndpointTestResult[],
): Record<string, EndpointStatEntry> {
  const testedAt = nowIso();
  const prev = prevStats && typeof prevStats === 'object' ? prevStats as Record<string, unknown> : {};
  const next: Record<string, EndpointStatEntry> = {};
  for (const result of results) {
    const prevEntry = prev[result.url] && typeof prev[result.url] === 'object'
      ? prev[result.url] as Partial<EndpointStatEntry>
      : undefined;
    const prevHistory = prevEntry?.schemaVersion === 1 && Array.isArray(prevEntry.history)
      ? prevEntry.history
      : [];
    const sample: EndpointStatSample = {
      latencyMs: result.latencyMs,
      usable: result.usable,
      httpStatus: result.httpStatus,
      testedAt,
    };
    next[result.url] = {
      schemaVersion: 1,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus,
      authStatus: result.authStatus,
      usable: result.usable,
      testedAt,
      history: [...prevHistory, sample].slice(-ENDPOINT_HISTORY_LIMIT),
    };
  }
  return next;
}

export function withSwitchMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = switchMutationQueue.then(operation, operation);
  switchMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const HEALTH_MONITOR_DEFAULTS: HealthMonitorSettings = {
  enabled: true,
  intervalMinutes: 5,
  autoFailoverTargets: [],
};

export function normalizeHealthMonitorSettings(input: unknown): HealthMonitorSettings {
  const source = input && typeof input === 'object' ? input as Partial<HealthMonitorSettings> : {};
  const interval = Number(source.intervalMinutes);
  return {
    enabled: source.enabled !== false,
    intervalMinutes: Number.isFinite(interval) ? Math.min(60, Math.max(1, Math.round(interval))) : HEALTH_MONITOR_DEFAULTS.intervalMinutes,
    autoFailoverTargets: Array.isArray(source.autoFailoverTargets)
      ? source.autoFailoverTargets.map((item) => safeText(item, 40).toLowerCase()).filter((item) => Boolean(TARGETS[item])).slice(0, 10)
      : [],
  };
}

/** Slot ids preserve case (built-ins like "longContext" are camelCase); strip only unsafe chars. */
export function sanitizeSlotId(value: unknown): string {
  return safeText(value, 48).replace(/[^a-zA-Z0-9_-]+/g, '').slice(0, 48);
}

export function normalizeRoutingSlots(input: unknown): RoutingSlots {
  if (!input || typeof input !== 'object') return {};
  const out: RoutingSlots = {};
  for (const [target, slots] of Object.entries(input as Record<string, unknown>)) {
    const normalizedTarget = normalizeTarget(target);
    if (!normalizedTarget || !slots || typeof slots !== 'object') continue;
    const bySlot: Record<string, RoutingSlotBinding> = {};
    for (const [slotId, binding] of Object.entries(slots as Record<string, unknown>)) {
      const slotKey = sanitizeSlotId(slotId);
      const providerId = binding && typeof binding === 'object' ? safeText((binding as Record<string, unknown>).providerId, 90) : '';
      if (!slotKey || !providerId) continue;
      const model = binding && typeof binding === 'object' ? safeText((binding as Record<string, unknown>).model, 200) : '';
      bySlot[slotKey] = model ? { providerId, model } : { providerId };
    }
    if (Object.keys(bySlot).length) out[normalizedTarget] = bySlot;
  }
  return out;
}

export async function readStore(): Promise<ProviderStore> {
  await ensureDir(switchDir());
  const store = await readJsonFile<ProviderStore>(providerStorePath(), {
    providers: [],
    activeByTarget: {},
    healthMonitor: HEALTH_MONITOR_DEFAULTS,
    routingSlots: {},
  });
  return {
    providers: (Array.isArray(store.providers) ? store.providers : []).map((provider) => ({
      ...provider,
      apiKey: decryptProviderSecret(provider.apiKey),
    })),
    activeByTarget: store.activeByTarget && typeof store.activeByTarget === 'object' ? store.activeByTarget : {},
    healthMonitor: normalizeHealthMonitorSettings(store.healthMonitor),
    routingSlots: normalizeRoutingSlots(store.routingSlots),
  };
}

export async function writeStore(store: ProviderStore): Promise<void> {
  const persisted: ProviderStore = {
    ...store,
    providers: store.providers.map((provider) => ({
      ...provider,
      apiKey: encryptProviderSecret(provider.apiKey),
    })),
  };
  await writeJsonFile(providerStorePath(), persisted);
}

export function upsertProviderInStore(store: ProviderStore, provider: SwitchProvider): void {
  const index = store.providers.findIndex((item) => item.id === provider.id);
  if (index === -1) store.providers.push(provider);
  else store.providers[index] = provider;
}

/** P95 latency from the rolling endpoint history used by smart routing. */
export function endpointLatencyP95(stats: unknown): number {
  const entry = stats && typeof stats === 'object' ? stats as { history?: unknown[]; latencyMs?: unknown } : {};
  const values = (Array.isArray(entry.history) ? entry.history : [])
    .map((sample) => sample && typeof sample === 'object' ? Number((sample as Record<string, unknown>).latencyMs) : NaN)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return Number(entry.latencyMs) || Number.MAX_SAFE_INTEGER;
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
}
