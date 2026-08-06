import type { DbClient } from './DbClient.js';

let current: { client: DbClient; userId: string } | null = null;

export function setCurrentDbClient(client: DbClient, userId: string): void {
  current = { client, userId };
}

export function clearCurrentDbClient(client?: DbClient): void {
  if (client && current?.client !== client) return;
  current = null;
}

export function getDbClient(): DbClient {
  if (!current) {
    throw new Error('DbClient not ready');
  }
  return current.client;
}

export function tryGetDbClient(): DbClient | null {
  return current?.client ?? null;
}

export function getCurrentDbClientUserId(): string | null {
  return current?.userId ?? null;
}
