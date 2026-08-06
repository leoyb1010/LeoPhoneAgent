/**
 * Shim: openclaw/plugin-sdk/gateway-runtime.
 *
 * The browser runtime runs the route handlers in-process via the dispatcher —
 * there is NO gateway HTTP server, node-host, or CLI client. So:
 *   - `isLoopbackHost` is faithfully implemented (uses vendored net-policy).
 *   - gateway auth resolves to "none" (loopback in-process needs no bearer).
 *   - node-routing / gateway-client / errorShape symbols are dropped-path stubs:
 *     they exist only to satisfy the vendored `sdk-node-runtime` bridge's
 *     re-export surface and are never invoked on the dispatcher path. They throw
 *     if ever called, so a mistaken reach is loud rather than silent.
 */
import { isLoopbackIpAddress, normalizeIpAddress } from '../_generated/packages/net-policy/ip.js';

/** Faithful loopback check over the vendored net-policy primitives. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const normalized = normalizeIpAddress(h) ?? h;
  return isLoopbackIpAddress(normalized);
}

export type GatewayAuthResolved = {
  token?: string;
  password?: string;
  mode: 'none' | 'token' | 'password' | 'trusted-proxy';
};

/** Loopback in-process: no gateway auth. */
export function resolveGatewayAuth(_opts?: unknown): GatewayAuthResolved {
  return { mode: 'none' };
}

/** Loopback in-process: nothing to ensure. Returns empty auth (no token/password). */
export async function ensureGatewayStartupAuth(
  _params?: unknown,
): Promise<{ auth: { token?: string; password?: string }; generatedToken?: string }> {
  return { auth: {} };
}

export function safeParseJson<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function errorShape(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export const ErrorCodes = {
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  INVALID: 'INVALID',
} as const;

// ── dropped-path stubs (gateway server / node-host / CLI client) ─────────────
function dropped(name: string): never {
  throw new Error(`gateway-runtime.${name} is not available in the in-process browser runtime`);
}
export function addGatewayClientOptions(): never {
  return dropped('addGatewayClientOptions');
}
export function callGatewayFromCli(): never {
  return dropped('callGatewayFromCli');
}
export function isNodeCommandAllowed(): boolean {
  return false;
}
export function resolveNodeCommandAllowlist(): string[] {
  return [];
}
export function respondUnavailableOnNodeInvokeError(): never {
  return dropped('respondUnavailableOnNodeInvokeError');
}

export type GatewayRequestHandlers = Record<string, never>;
export type GatewayRpcOpts = Record<string, never>;
export type NodeSession = Record<string, never>;
