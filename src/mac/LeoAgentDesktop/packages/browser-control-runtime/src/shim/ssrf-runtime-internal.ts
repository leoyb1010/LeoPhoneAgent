/**
 * Shim: openclaw/plugin-sdk/ssrf-runtime-internal.
 *
 * Upstream registers a managed-proxy CDP bypass so the agent's managed proxy
 * does not intercept loopback CDP traffic. We run the browser runtime
 * loopback-only without the managed-proxy stack, so this is a safe no-op.
 */

/**
 * No-op bypass: we do not run the upstream managed-proxy stack (loopback-only).
 * Returns an optional release fn to match the upstream call shape
 * (`const release = registerManagedProxyBrowserCdpBypass(url); release?.()`).
 */
export function registerManagedProxyBrowserCdpBypass(_url?: string): (() => void) | undefined {
  return undefined;
}
