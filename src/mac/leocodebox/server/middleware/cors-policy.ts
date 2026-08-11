import cors from 'cors';

import { IS_LOCAL_ONLY_AUTH } from './auth.js';

function isLoopbackOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const allowedOrigins = (process.env.LEOCODEBOX_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

export function isAllowedOrigin(origin?: string): boolean {
  if (IS_LOCAL_ONLY_AUTH || isLoopbackOrigin(origin)) return isLoopbackOrigin(origin);
  return Boolean(origin && allowedOrigins.includes(origin));
}

export function createCorsMiddleware() {
  return cors({
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    exposedHeaders: ['X-Refreshed-Token'],
  });
}
