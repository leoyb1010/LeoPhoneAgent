import { appConfigDb } from '@/modules/database/index.js';

import { applyProviderTransactionally } from './provider-apply.service.js';
import { probeProviderHealth } from './provider-discovery.service.js';
import type { ProviderHealthProbe } from './provider-discovery.service.js';
import { adoptLiveProviderEdits } from './provider-import.service.js';
import {
  endpointLatencyP95,
  readStore,
  upsertProviderInStore,
  withSwitchMutation,
  writeStore,
} from './provider-store.service.js';
import type { SwitchProvider } from './provider-store.service.js';
import { TARGETS } from './provider-switch.config.js';
import { nowIso } from './provider-switch.storage.js';

/**
 * Background health monitor for the active Leoapi provider of each target.
 *
 * Design constraints (deliberate, keep them):
 * - Probes are the cost-free GET model-list probe — a poll NEVER spends tokens
 *   or hits chat endpoints (see probeProviderHealth).
 * - Only the ACTIVE provider per writable target is probed; idle providers cost
 *   nothing until they are considered as failover candidates.
 * - Auto-failover is per-target opt-in (default off). Even when on, it only
 *   fires on the ok→degraded transition, applies through the same transactional
 *   apply path as a manual switch, and records what it did so the UI can offer
 *   a one-click undo (undo = plain re-apply of the previous provider).
 * - The last snapshot is persisted for diagnostics/trend continuity; the next
 *   live probe still remains authoritative.
 */

export type TargetHealthStatus = 'ok' | 'degraded' | 'unknown';

export type TargetHealth = {
  target: string;
  providerId: string;
  providerName: string;
  status: TargetHealthStatus;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastHttpStatus: number | null;
  lastNote: string;
  lastCheckedAt: string;
  /** Set when this monitor auto-switched the target; cleared on next manual apply. */
  lastAutoFailover: { fromId: string; fromName: string; toId: string; toName: string; at: string } | null;
};

export type HealthSnapshot = {
  enabled: boolean;
  intervalMinutes: number;
  autoFailoverTargets: string[];
  lastRunAt: string | null;
  targets: Record<string, TargetHealth>;
};

/** Consecutive failed polls before a target flips to degraded (≈2 intervals). */
export const DEGRADE_THRESHOLD = 2;

/**
 * Minimum gap between AUTOMATIC failovers per target. Degrading takes 2 failed
 * polls but a candidate is promoted on a single passing probe, so two
 * half-broken nodes could otherwise ping-pong forever, rewriting the live CLI
 * config every couple of intervals. Manual failover is never throttled.
 */
export const AUTO_FAILOVER_COOLDOWN_MS = 30 * 60 * 1000;

type ProbeFn = (provider: SwitchProvider) => Promise<ProviderHealthProbe>;

const healthByTarget = new Map<string, TargetHealth>();
const lastAutoFailoverAt = new Map<string, number>();
let lastRunAt: string | null = null;
let tickInFlight = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let lastPollAt = 0;
const HEALTH_STATE_KEY = 'leoapi_health_state';
let healthHydrated = false;

function hydrateHealthState(): void {
  if (healthHydrated) return;
  healthHydrated = true;
  try {
    const raw = appConfigDb.get(HEALTH_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { lastRunAt?: string | null; targets?: Record<string, TargetHealth> };
    lastRunAt = parsed.lastRunAt ?? null;
    for (const [target, value] of Object.entries(parsed.targets || {})) healthByTarget.set(target, value);
  } catch { /* corrupt snapshots are replaced after the next probe */ }
}

function persistHealthState(): void {
  appConfigDb.set(HEALTH_STATE_KEY, JSON.stringify({ lastRunAt, targets: Object.fromEntries(healthByTarget) }));
}

function baseHealth(target: string, provider: SwitchProvider): TargetHealth {
  return {
    target,
    providerId: provider.id,
    providerName: provider.name,
    status: 'unknown',
    consecutiveFailures: 0,
    lastLatencyMs: null,
    lastHttpStatus: null,
    lastNote: '',
    lastCheckedAt: '',
    lastAutoFailover: null,
  };
}

/** Pick the first same-target sibling that passes a live probe. Sequential on purpose — candidates are probed one at a time, cheapest-first by stored latency. */
async function findHealthyFailoverCandidate(
  providers: SwitchProvider[],
  target: string,
  excludeId: string,
  probe: ProbeFn,
): Promise<SwitchProvider | null> {
  const candidates = providers
    .filter((provider) => provider.target === target && provider.id !== excludeId && provider.baseUrl)
    .sort((left, right) => {
      const leftStat = endpointLatencyP95(left.endpointStats?.[left.baseUrl]);
      const rightStat = endpointLatencyP95(right.endpointStats?.[right.baseUrl]);
      return leftStat - rightStat;
    });
  for (const candidate of candidates) {
    try {
      const result = await probe(candidate);
      if (result.ok) return candidate;
    } catch {
      // A throwing probe just disqualifies the candidate.
    }
  }
  return null;
}

/**
 * Fail the target over to a live-probed healthy sibling.
 *
 * Concurrency contract:
 * - Candidate probing happens OUTSIDE the switch mutation lock — with N dead
 *   candidates at 8s timeout each, holding the lock would block every manual
 *   apply/save for ~8s×N. The lock only wraps the validate-and-apply step.
 * - Inside the lock we re-read the store and re-check (a) the target is still
 *   on `from` (a manual switch may have raced us) and (b) for the automatic
 *   path, that the user hasn't just disabled the monitor or this target's
 *   opt-in mid-tick.
 * - Before switching away we fold live hand edits back into the outgoing
 *   provider record (same lean write-back semantics as a manual apply), so the
 *   one-click undo restores what the user actually ran today.
 * - Automatic runs are rate-limited by AUTO_FAILOVER_COOLDOWN_MS per target to
 *   prevent half-broken siblings from ping-ponging the live config.
 */
async function failoverToHealthySibling(
  target: string,
  from: SwitchProvider,
  probe: ProbeFn,
  options: { manual: boolean },
): Promise<TargetHealth['lastAutoFailover']> {
  if (!options.manual) {
    const lastAt = lastAutoFailoverAt.get(target) ?? 0;
    if (Date.now() - lastAt < AUTO_FAILOVER_COOLDOWN_MS) return null;
  }

  // Probe outside the lock (see contract above).
  const preStore = await readStore();
  if (preStore.activeByTarget[target] !== from.id) return null;
  const candidate = await findHealthyFailoverCandidate(preStore.providers, target, from.id, probe);
  if (!candidate) return null;

  return withSwitchMutation(async () => {
    const store = await readStore();
    if (store.activeByTarget[target] !== from.id) return null;
    if (!options.manual
      && (!store.healthMonitor.enabled || !store.healthMonitor.autoFailoverTargets.includes(target))) {
      return null;
    }
    // Use the freshest record for the candidate; it may have been edited/deleted.
    const liveCandidate = store.providers.find((item) => item.id === candidate.id);
    if (!liveCandidate?.baseUrl) return null;
    await adoptLiveProviderEdits(store, target);
    await applyProviderTransactionally(liveCandidate, async () => {
      store.activeByTarget[target] = liveCandidate.id;
      liveCandidate.lastAppliedAt = nowIso();
      liveCandidate.updatedAt = nowIso();
      upsertProviderInStore(store, liveCandidate);
      await writeStore(store);
    });
    if (!options.manual) lastAutoFailoverAt.set(target, Date.now());
    return { fromId: from.id, fromName: from.name, toId: liveCandidate.id, toName: liveCandidate.name, at: nowIso() };
  });
}

/**
 * User-initiated "switch me to something that actually answers" (the degraded
 * banner button). Live-probes candidates like the automatic path — never the
 * stale model-discovery ranking — but skips the opt-in check and cooldown:
 * an explicit click IS the consent.
 */
export async function runManualFailover(target: string, probe: ProbeFn = probeProviderHealth): Promise<TargetHealth['lastAutoFailover']> {
  const store = await readStore();
  const activeId = store.activeByTarget[target];
  const from = activeId ? store.providers.find((item) => item.id === activeId) : null;
  if (!from) return null;
  const failover = await failoverToHealthySibling(target, from, probe, { manual: true });
  if (failover) {
    const entry = healthByTarget.get(target);
    const next = baseHealth(target, { ...from, id: failover.toId, name: failover.toName } as SwitchProvider);
    next.status = 'ok';
    next.lastAutoFailover = failover;
    next.lastCheckedAt = nowIso();
    if (entry) next.lastLatencyMs = entry.lastLatencyMs;
    healthByTarget.set(target, next);
  }
  return failover;
}

/**
 * One polling round: probe the active provider of every writable target and
 * update the in-memory health map. Exported with an injectable probe so tests
 * can drive the state machine without network.
 */
export async function runHealthTick(probe: ProbeFn = probeProviderHealth): Promise<HealthSnapshot> {
  if (tickInFlight) {
    // Still report the PERSISTED settings — a bare snapshot would show defaults
    // and the UI would render (or worse, re-save) wrong preferences.
    return getHealthSnapshot((await readStore()).healthMonitor);
  }
  tickInFlight = true;
  try {
    const store = await readStore();
    lastRunAt = nowIso();
    const seenTargets = new Set<string>();

    for (const [target, providerId] of Object.entries(store.activeByTarget)) {
      if (!TARGETS[target]?.writable) continue;
      const provider = store.providers.find((item) => item.id === providerId);
      if (!provider || !provider.baseUrl) {
        healthByTarget.delete(target);
        continue;
      }
      seenTargets.add(target);

      const previous = healthByTarget.get(target);
      const entry: TargetHealth = previous && previous.providerId === provider.id
        ? { ...previous, providerName: provider.name }
        : baseHealth(target, provider);

      // A throwing probe (e.g. an invalid baseUrl on an imported provider) must
      // count as a failed sample for THIS target, never kill the whole tick.
      let result: ProviderHealthProbe;
      try {
        result = await probe(provider);
      } catch (error) {
        result = {
          ok: false,
          latencyMs: null,
          httpStatus: null,
          note: `探测异常：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      entry.lastLatencyMs = result.latencyMs;
      entry.lastHttpStatus = result.httpStatus;
      entry.lastNote = result.note;
      entry.lastCheckedAt = nowIso();

      if (result.ok) {
        entry.consecutiveFailures = 0;
        entry.status = 'ok';
      } else {
        entry.consecutiveFailures += 1;
        const wasDegraded = entry.status === 'degraded';
        entry.status = entry.consecutiveFailures >= DEGRADE_THRESHOLD ? 'degraded' : entry.status === 'ok' ? 'ok' : 'unknown';
        if (entry.status === 'degraded' && !wasDegraded
          && store.healthMonitor.autoFailoverTargets.includes(target)) {
          const failover = await failoverToHealthySibling(target, provider, probe, { manual: false });
          if (failover) {
            const next = baseHealth(target, { ...provider, id: failover.toId, name: failover.toName } as SwitchProvider);
            next.status = 'ok';
            next.lastAutoFailover = failover;
            next.lastCheckedAt = nowIso();
            healthByTarget.set(target, next);
            continue;
          }
        }
      }
      // Re-sync the breadcrumb from the LIVE map entry before writing back: a
      // manual apply may have cleared it while we were awaiting the probe, and
      // our pre-probe copy must not resurrect it.
      const liveEntry = healthByTarget.get(target);
      entry.lastAutoFailover = liveEntry && liveEntry.providerId === entry.providerId
        ? liveEntry.lastAutoFailover
        : null;
      healthByTarget.set(target, entry);
    }

    // Drop stale entries for targets that no longer have an active provider.
    for (const target of [...healthByTarget.keys()]) {
      if (!seenTargets.has(target)) healthByTarget.delete(target);
    }
    persistHealthState();
    return getHealthSnapshot(store.healthMonitor);
  } finally {
    tickInFlight = false;
  }
}

export function getHealthSnapshot(settings?: { enabled: boolean; intervalMinutes: number; autoFailoverTargets: string[] }): HealthSnapshot {
  hydrateHealthState();
  return {
    enabled: settings?.enabled ?? true,
    intervalMinutes: settings?.intervalMinutes ?? 5,
    autoFailoverTargets: settings?.autoFailoverTargets ?? [],
    lastRunAt,
    targets: Object.fromEntries(healthByTarget),
  };
}

/** Manual apply must clear the auto-failover breadcrumb — the user has taken over. */
export function clearAutoFailoverRecord(target: string): void {
  const entry = healthByTarget.get(target);
  if (entry?.lastAutoFailover) healthByTarget.set(target, { ...entry, lastAutoFailover: null });
}

/**
 * Start the background scheduler. A fixed 60s heartbeat checks whether a poll
 * is due per the persisted interval, so settings changes take effect without
 * timer juggling. unref() keeps the timer from blocking process exit.
 */
export function startHealthMonitor(): void {
  hydrateHealthState();
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void (async () => {
      try {
        const store = await readStore();
        if (!store.healthMonitor.enabled) return;
        const dueMs = store.healthMonitor.intervalMinutes * 60_000;
        if (Date.now() - lastPollAt < dueMs) return;
        lastPollAt = Date.now();
        await runHealthTick();
      } catch (error) {
        console.warn('Leoapi health monitor tick failed:', error);
      }
    })();
  }, 60_000);
  schedulerTimer.unref();
}

export function stopHealthMonitor(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

/** Test hook: reset all in-memory monitor state. */
export function resetHealthStateForTests(): void {
  healthByTarget.clear();
  lastAutoFailoverAt.clear();
  lastRunAt = null;
  lastPollAt = 0;
  tickInFlight = false;
}
