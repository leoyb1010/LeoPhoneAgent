/**
 * Forwarding core for the Leoapi gateway. Resolves the target Leoapi provider
 * from the opaque request token, forwards the request to that provider's real
 * upstream verbatim, streams the response straight back (so it can never be
 * reframed or corrupted), and tee-reads a copy to meter wire-level tokens.
 */
import type { IncomingHttpHeaders } from 'node:http';

import { normalizeTarget, readStore, type ProviderStore, type SwitchProvider } from '../provider-store.service.js';

import { GATEWAY_TOKEN_PREFIX } from './gateway-config.js';
import { recordGatewayRequest } from './gateway-meter.js';

export type ResolvedUpstream = { providerId: string; providerName: string; baseUrl: string; apiKey: string };

/** Extract the raw gateway token (after `lgw:`) from the incoming auth headers. */
export function parseGatewayToken(headers: IncomingHttpHeaders): string | null {
  const raw = String(headers['x-api-key'] || '')
    || String(headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!raw.startsWith(GATEWAY_TOKEN_PREFIX)) return null;
  const rest = raw.slice(GATEWAY_TOKEN_PREFIX.length).trim();
  return rest || null;
}

function toUpstream(provider: SwitchProvider | undefined): ResolvedUpstream | null {
  if (!provider?.baseUrl) return null;
  return { providerId: provider.id, providerName: provider.name || provider.id, baseUrl: provider.baseUrl.replace(/\/+$/, ''), apiKey: provider.apiKey };
}

/**
 * Resolve an ORDERED chain of upstreams for a gateway token — primary first,
 * then same-target siblings as failover candidates. The token is resolved at
 * REQUEST time (not spawn), so switching the active node / slot binding takes
 * effect on the next request (mid-session routing). Pure over the store, so
 * routing + failover ordering are unit-testable.
 *
 * Token forms:
 *   lgw:<target>          → active node for the target, then siblings
 *   lgw:<target>:<slot>   → the slot's bound node (fallback active), then siblings
 *   lgw:<providerId>      → that exact node only (legacy / pinned, no failover)
 */
export function selectUpstreamChain(store: ProviderStore, token: string): ResolvedUpstream[] {
  const [head, slot] = token.split(':');
  const target = normalizeTarget(head);
  if (target) {
    const binding = slot ? store.routingSlots?.[target]?.[slot] : undefined;
    const primaryId = binding?.providerId || store.activeByTarget?.[target];
    const primary = primaryId ? store.providers.find((p) => p.id === primaryId) : undefined;
    const siblings = store.providers.filter((p) => p.target === target && p.id !== primary?.id);
    const ordered: (SwitchProvider | undefined)[] = [primary, ...siblings];
    return ordered.map(toUpstream).filter((u): u is ResolvedUpstream => u !== null);
  }
  const pinned = store.providers.find((p) => p.id === token);
  const up = toUpstream(pinned);
  return up ? [up] : [];
}

/** Resolve the request-time upstream chain (primary + failover siblings). */
export async function resolveUpstreamChain(headers: IncomingHttpHeaders): Promise<ResolvedUpstream[]> {
  const token = parseGatewayToken(headers);
  if (!token) return [];
  return selectUpstreamChain(await readStore(), token);
}

// Headers we must not copy through (hop-by-hop, or ones we set ourselves).
const STRIP_REQUEST_HEADERS = new Set(['host', 'content-length', 'x-api-key', 'authorization', 'connection']);
const STRIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);

export function buildUpstreamHeaders(incoming: IncomingHttpHeaders, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null || STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  // Anthropic-compatible upstreams take the key as x-api-key; also set a Bearer
  // for gateways that expect Authorization.
  out['x-api-key'] = apiKey;
  out['authorization'] = `Bearer ${apiKey}`;
  return out;
}

type UsageParse = { model: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number };

/**
 * Extract token usage from a buffered copy of an Anthropic Messages response —
 * both SSE (message_start + message_delta) and non-streaming JSON shapes.
 * Never throws: metering must not affect the forwarded stream.
 */
export function parseAnthropicUsage(body: string): UsageParse {
  const result: UsageParse = { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  try {
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{')) {
      const json = JSON.parse(trimmed);
      applyUsageObject(result, json?.model, json?.usage);
      return result;
    }
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.type === 'message_start') {
        const message = event.message as Record<string, unknown> | undefined;
        applyUsageObject(result, message?.model, message?.usage as Record<string, unknown> | undefined);
      } else if (event.type === 'message_delta') {
        applyUsageObject(result, null, event.usage as Record<string, unknown> | undefined);
      }
    }
  } catch { /* metering is best-effort */ }
  return result;
}

function applyUsageObject(result: UsageParse, model: unknown, usage: Record<string, unknown> | undefined): void {
  if (typeof model === 'string' && model) result.model = model;
  if (!usage) return;
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  const cacheRead = Number(usage.cache_read_input_tokens);
  if (Number.isFinite(input) && input > 0) result.inputTokens = input;
  if (Number.isFinite(output) && output > 0) result.outputTokens = output;
  if (Number.isFinite(cacheRead) && cacheRead > 0) result.cacheReadTokens = cacheRead;
}

export const gatewayInternals = { STRIP_RESPONSE_HEADERS };

/** Meter a completed proxied request from a buffered response copy + status. */
export function meterFromResponse(providerTarget: string, body: string, status: number): void {
  const usage = parseAnthropicUsage(body);
  recordGatewayRequest({
    provider: providerTarget,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    status,
  });
}
