/**
 * Shim: openclaw/plugin-sdk/core — only `resolveGatewayPort` is consumed.
 * The browser runtime is loopback-only and derives ports from a fixed base;
 * there is no live gateway, so we return a stable default base port. The CDP
 * port range is then derived from it by the vendored config resolver.
 */
const DEFAULT_GATEWAY_PORT = 18789;

export function resolveGatewayPort(_rootConfig?: unknown): number {
  const env = process.env.XDT_BROWSER_GATEWAY_PORT?.trim();
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_GATEWAY_PORT;
}
