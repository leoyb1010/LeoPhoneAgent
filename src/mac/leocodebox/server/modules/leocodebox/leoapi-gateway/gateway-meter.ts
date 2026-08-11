/**
 * Wire-level meter for the Leoapi gateway. Unlike usage_daily (a post-run
 * aggregate written once per session by the run registry), this records EVERY
 * proxied request as it completes — the first request-level token truth in the
 * app. Kept in-memory (a small ring buffer + running totals) so it never
 * touches or double-counts the existing usage_daily accounting; the dashboard
 * reads it through the gateway status endpoint.
 */
import { estimateUsageCostUsd } from '../../usage/index.js';


export type GatewayRequestRecord = {
  at: number;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  status: number;
  ok: boolean;
};

const RING_CAPACITY = 50;

type Totals = { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };

let recent: GatewayRequestRecord[] = [];
let today = { day: isoDay(), totals: emptyTotals() };
let sinceStart: Totals = emptyTotals();

function emptyTotals(): Totals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

function isoDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function add(target: Totals, rec: GatewayRequestRecord): void {
  target.requests += 1;
  target.inputTokens += rec.inputTokens;
  target.outputTokens += rec.outputTokens;
  target.cacheReadTokens += rec.cacheReadTokens;
  target.costUsd += rec.costUsd;
}

/** Record one completed proxied request. `usage` is the model-reported token usage. */
export function recordGatewayRequest(input: {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  status: number;
}): GatewayRequestRecord {
  const costUsd = estimateUsageCostUsd(input.provider, input.model, input.inputTokens, input.outputTokens);
  const rec: GatewayRequestRecord = { at: Date.now(), ...input, costUsd, ok: input.status >= 200 && input.status < 300 };

  recent.unshift(rec);
  if (recent.length > RING_CAPACITY) recent.length = RING_CAPACITY;

  const day = isoDay();
  if (today.day !== day) today = { day, totals: emptyTotals() };
  add(today.totals, rec);
  add(sinceStart, rec);
  return rec;
}

export function gatewayMeterSnapshot() {
  // Derived, honest signals over the retained window (no extra state): how many
  // distinct nodes actually served, and how many upstream attempts returned a
  // non-2xx (each such attempt is a failover trigger unless it was the last
  // node). This is what makes pillar-2 routing/failover visible at a glance.
  const activeNodes = new Set(recent.map((rec) => rec.provider)).size;
  const retries = recent.reduce((n, rec) => (rec.ok ? n : n + 1), 0);
  return {
    today: { ...today.totals, day: today.day },
    sinceStart: { ...sinceStart },
    routing: { activeNodes, retries, window: recent.length },
    recent: recent.slice(0, 12),
  };
}

/** Test-only reset. */
export function __resetGatewayMeter(): void {
  recent = [];
  today = { day: isoDay(), totals: emptyTotals() };
  sinceStart = emptyTotals();
}
