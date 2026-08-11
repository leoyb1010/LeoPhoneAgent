import type { VerifyClientCallbackSync } from 'ws';

import { logger } from '@/modules/logging/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  isLocalOnly: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
};

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1');
  } catch {
    return false;
  }
}

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  logger.info('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  if (dependencies.isLocalOnly && !isLoopbackOrigin(request.headers.origin)) {
    logger.info('[WARN] Local-only WebSocket rejected origin:', request.headers.origin || '(none)');
    return false;
  }

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      logger.info('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    logger.info('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    logger.info('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  logger.info('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
