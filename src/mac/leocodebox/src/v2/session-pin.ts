import { sessionKey } from './model';

export const PINNED_SESSIONS_KEY = 'leo2.pinnedSessions';

export function readPinnedSessionKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.includes(':')) : [];
  } catch {
    return [];
  }
}

export function sessionIsPinned(pinned: readonly string[], machine: string, id: string): boolean {
  return pinned.includes(sessionKey(machine, id));
}

export function togglePinnedSessionKey(pinned: readonly string[], key: string): string[] {
  return pinned.includes(key) ? pinned.filter((item) => item !== key) : [...pinned, key];
}

export function pinSessionToast(pinned: boolean): string {
  return pinned ? '已钉在左栏上面' : '已取消钉住';
}

export function comparePinnedFirst(aPinned: boolean, bPinned: boolean, fallback: number): number {
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  return fallback;
}
