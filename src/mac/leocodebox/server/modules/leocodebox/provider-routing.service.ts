/**
 * Leoapi routing control plane (L2). Scenario "slots" bind a task shape to a
 * specific Leoapi provider + optional model, so a session can be routed to the
 * cheap model for background chores, a long-context model when the first prompt
 * is huge, etc. — without any resident proxy process. Resolution happens at
 * session start; the chosen slot's provider is injected via the existing
 * per-session env takeover (applyActiveSwitchEnv), so there is zero new network
 * surface and the "本机原配置" contract is preserved when nothing is bound.
 */
import {
  normalizeTarget,
  sanitizeSlotId,
  readStore,
  writeStore,
  withSwitchMutation,
  type RoutingSlotBinding,
} from './provider-store.service.js';

/** Built-in scenario slots. Users may also bind arbitrary custom slot ids. */
export const BUILTIN_SLOTS = ['default', 'background', 'longContext', 'think'] as const;

/** Above this estimated first-prompt token count, prefer the longContext slot. */
export const LONG_CONTEXT_TOKEN_THRESHOLD = 120_000;

type StatusError = Error & { statusCode?: number };

function badRequest(message: string): StatusError {
  const error: StatusError = new Error(message);
  error.statusCode = 400;
  return error;
}

/** All slot bindings for a target (empty object when none configured). */
export async function getRoutingSlots(target: string): Promise<Record<string, RoutingSlotBinding>> {
  const normalized = normalizeTarget(target);
  if (!normalized) throw badRequest('Unsupported provider target.');
  const store = await readStore();
  return store.routingSlots?.[normalized] ?? {};
}

/** Bind a slot to a provider (+ optional model). Provider must exist for the target. */
export async function setRoutingSlot(target: string, slotId: string, binding: RoutingSlotBinding): Promise<Record<string, RoutingSlotBinding>> {
  const normalized = normalizeTarget(target);
  if (!normalized) throw badRequest('Unsupported provider target.');
  const slot = sanitizeSlotId(slotId);
  if (!slot) throw badRequest('Slot id is required.');
  const providerId = String(binding?.providerId || '').trim();
  if (!providerId) throw badRequest('providerId is required.');
  return withSwitchMutation(async () => {
    const store = await readStore();
    const provider = store.providers.find((item) => item.id === providerId);
    if (!provider) throw badRequest('Unknown provider for this slot.');
    if (provider.target !== normalized) throw badRequest('Provider target does not match slot target.');
    const model = String(binding?.model || '').trim();
    const next = { ...(store.routingSlots ?? {}) };
    next[normalized] = { ...(next[normalized] ?? {}), [slot]: model ? { providerId, model } : { providerId } };
    await writeStore({ ...store, routingSlots: next });
    return next[normalized];
  });
}

/** Remove a slot binding. */
export async function clearRoutingSlot(target: string, slotId: string): Promise<Record<string, RoutingSlotBinding>> {
  const normalized = normalizeTarget(target);
  if (!normalized) throw badRequest('Unsupported provider target.');
  return withSwitchMutation(async () => {
    const store = await readStore();
    const forTarget = { ...(store.routingSlots?.[normalized] ?? {}) };
    delete forTarget[sanitizeSlotId(slotId)];
    const next = { ...(store.routingSlots ?? {}) };
    if (Object.keys(forTarget).length) next[normalized] = forTarget;
    else delete next[normalized];
    await writeStore({ ...store, routingSlots: next });
    return next[normalized] ?? {};
  });
}

/**
 * Decide which slot a session should use.
 * Priority: explicit slot (from an agent profile) → background hint →
 * long-context by first-prompt size → default. Only returns a slot that is
 * actually BOUND for the target; otherwise returns null so the caller uses the
 * plain active provider (legacy behavior).
 */
export async function resolveSlotForSession(options: {
  target: string;
  slot?: string | null;
  estimatedTokens?: number | null;
  background?: boolean;
}): Promise<string | null> {
  const normalized = normalizeTarget(options.target);
  if (!normalized) return null;
  const bound = await getRoutingSlots(normalized);
  if (Object.keys(bound).length === 0) return null;

  const explicit = String(options.slot || '').trim();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (options.background) candidates.push('background');
  if ((options.estimatedTokens ?? 0) >= LONG_CONTEXT_TOKEN_THRESHOLD) candidates.push('longContext');
  candidates.push('default');

  for (const candidate of candidates) {
    if (bound[candidate]?.providerId) return candidate;
  }
  return null;
}
