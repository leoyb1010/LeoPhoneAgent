import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const attentionWorkerIds = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();

function emit(): void {
  snapshot = new Set(attentionWorkerIds);
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkerAttentionSnapshot(): ReadonlySet<string> {
  return snapshot;
}

export function useWorkerAttentionSnapshot(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    getWorkerAttentionSnapshot,
    getWorkerAttentionSnapshot,
  );
}

export function hasWorkerAttention(workerId: string): boolean {
  return attentionWorkerIds.has(workerId);
}

export function markWorkerAttention(workerId: string): void {
  if (attentionWorkerIds.has(workerId)) return;
  attentionWorkerIds.add(workerId);
  emit();
}

export function clearWorkerAttention(workerId: string): boolean {
  if (!attentionWorkerIds.delete(workerId)) return false;
  emit();
  return true;
}

export function clearWorkerAttentionMany(workerIds: Iterable<string>): number {
  let changed = 0;
  for (const workerId of workerIds) {
    if (attentionWorkerIds.delete(workerId)) changed += 1;
  }
  if (changed > 0) emit();
  return changed;
}

export function __resetWorkerAttentionStoreForTest(): void {
  attentionWorkerIds.clear();
  snapshot = new Set();
  listeners.clear();
}

export function __getWorkerAttentionSnapshotForTest(): ReadonlySet<string> {
  return getWorkerAttentionSnapshot();
}
