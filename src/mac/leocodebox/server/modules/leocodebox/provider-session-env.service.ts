import { readStore } from './provider-store.service.js';
import { GATEWAY_TOKEN_PREFIX, gatewayBaseUrl, isGatewayEnabled } from './leoapi-gateway/gateway-config.js';

const CLAUDE_OWNED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export function buildEffectiveSessionEnv(
  inheritedEnv: Record<string, string | undefined>,
  target: 'claude' | 'codex',
  provider: { baseUrl?: string; apiKey?: string; model?: string; modelMapping?: Record<string, string> },
): Record<string, string> {
  const result = { ...inheritedEnv } as Record<string, string>;
  const ownedKeys = target === 'claude' ? CLAUDE_OWNED_ENV_KEYS : ['OPENAI_API_KEY'] as const;
  for (const key of ownedKeys) delete result[key];

  if (target === 'claude') {
    if (provider.baseUrl) result.ANTHROPIC_BASE_URL = provider.baseUrl;
    if (provider.apiKey) {
      result.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
      result.ANTHROPIC_API_KEY = provider.apiKey;
    }
    if (provider.model) result.ANTHROPIC_MODEL = provider.model;
    const mapping = provider.modelMapping || {};
    if (mapping.sonnet || provider.model) result.ANTHROPIC_DEFAULT_SONNET_MODEL = mapping.sonnet || provider.model!;
    if (mapping.opus || provider.model) result.ANTHROPIC_DEFAULT_OPUS_MODEL = mapping.opus || provider.model!;
    if (mapping.haiku || provider.model) result.ANTHROPIC_DEFAULT_HAIKU_MODEL = mapping.haiku || provider.model!;
  } else if (provider.apiKey) {
    result.OPENAI_API_KEY = provider.apiKey;
  }
  return result;
}

/**
 * Env overlay that makes the active Leoapi provider authoritative for
 * sessions started by this app. With nothing active, the machine environment
 * remains authoritative so existing local CLI behavior is preserved.
 */
export async function getActiveSwitchEnvOverlay(target: 'claude' | 'codex', slot?: string): Promise<Record<string, string>> {
  try {
    const store = await readStore();
    // A bound routing slot wins over the single active provider; an unbound
    // slot (or no slot) falls back to activeByTarget — preserving legacy behavior.
    const binding = slot ? store.routingSlots?.[target]?.[slot] : undefined;
    // A slot may dangle (its provider was deleted). Resolve the slot's provider,
    // but if it no longer exists fall back to the active provider rather than
    // silently dropping the session to the machine env.
    const boundProvider = binding?.providerId ? store.providers.find((item) => item.id === binding.providerId) : undefined;
    const activeId = store.activeByTarget?.[target];
    const provider = boundProvider ?? (activeId ? store.providers.find((item) => item.id === activeId) : undefined);
    if (!provider) return {};
    const effective = boundProvider && binding?.model ? { ...provider, model: binding.model } : provider;
    const env = buildEffectiveSessionEnv({}, target, effective);

    // Leoapi gateway (opt-in): when on, point the claude CLI at the loopback
    // metering gateway with an opaque token that resolves back to THIS node, so
    // the real key never enters the CLI env and every request is metered. The
    // node's real baseUrl stays in the store for the gateway to forward to. Off
    // by default → this block is skipped and behavior is exactly as before.
    if (target === 'claude' && effective.baseUrl && isGatewayEnabled()) {
      const gwUrl = gatewayBaseUrl();
      if (gwUrl) {
        // Token carries the TARGET (+ slot) rather than a fixed node id, so the
        // gateway resolves the current node per request: switching the active
        // node / slot binding takes effect on the next request (mid-session
        // routing), and a retryable upstream error fails over to a sibling.
        const token = `${GATEWAY_TOKEN_PREFIX}${target}${slot ? `:${slot}` : ''}`;
        env.ANTHROPIC_BASE_URL = gwUrl;
        env.ANTHROPIC_AUTH_TOKEN = token;
        env.ANTHROPIC_API_KEY = token;
      }
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * Every env var the active provider "owns" for a target. Used to clear stale
 * inherited values (e.g. exports left in the login shell by another switcher
 * like cc-switch) so ONLY the active provider's values reach the agent CLI.
 */
const MANAGED_SWITCH_ENV_KEYS: Record<'claude' | 'codex', readonly string[]> = {
  claude: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ],
  codex: ['OPENAI_API_KEY'],
};

/**
 * Make the active Leoapi provider AUTHORITATIVE in a child-process env.
 *
 * The overlay alone was not enough: agent CLIs give process env precedence over
 * their config files, and this app imports the ANTHROPIC_ and OPENAI_ agent vars
 * from the login shell (electron/runtimePath.js). So on a machine where cc-switch (or a
 * manual rc export) left a stale ANTHROPIC_BASE_URL/key in the login shell, that
 * value was inherited into the child env and — for any key the active provider
 * did not itself set — leaked through and beat everything Leoapi wrote. Changing
 * the endpoint in Leoapi then "did nothing": the CLI stayed locked to the old
 * exported value.
 *
 * Fix: when a provider is active, CLEAR every managed key first, then apply the
 * overlay — so the active provider fully replaces any inherited value (an empty
 * baseUrl correctly falls back to the official endpoint instead of a stale one).
 * With NO active provider, the child env is returned untouched, preserving the
 * "本机原配置" contract (the machine's own shell/config stays in charge).
 */
export async function applyActiveSwitchEnv<T extends Record<string, string | undefined>>(
  childEnv: T,
  target: 'claude' | 'codex',
  slot?: string,
): Promise<T> {
  const overlay = await getActiveSwitchEnvOverlay(target, slot);
  if (Object.keys(overlay).length === 0) return childEnv;
  const next = { ...childEnv } as T;
  for (const key of MANAGED_SWITCH_ENV_KEYS[target]) delete next[key];
  return { ...next, ...overlay } as T;
}
