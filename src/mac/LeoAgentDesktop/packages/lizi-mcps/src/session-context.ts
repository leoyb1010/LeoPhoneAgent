import { AsyncLocalStorage } from 'node:async_hooks';

import type { LiziMcpSessionContext } from './types.js';

const storage = new AsyncLocalStorage<LiziMcpSessionContext>();

export function runWithLiziMcpSessionContext<T>(
  ctx: LiziMcpSessionContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getLiziMcpSessionContext(): LiziMcpSessionContext | undefined {
  return storage.getStore();
}

export function resolveLiziMcpSessionContext<T extends LiziMcpSessionContext>(
  fallback: T,
): T {
  return (storage.getStore() as T | undefined) ?? fallback;
}
