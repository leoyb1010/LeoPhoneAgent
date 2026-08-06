import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __getWorkerAttentionSnapshotForTest,
  __resetWorkerAttentionStoreForTest,
  clearWorkerAttention,
  clearWorkerAttentionMany,
  hasWorkerAttention,
  markWorkerAttention,
  subscribe,
} from '@/features/cc-agent/lib/workerAttentionStore';

const WORKER_ID = 'worker-1';
const OTHER_WORKER_ID = 'worker-2';

afterEach(() => {
  __resetWorkerAttentionStoreForTest();
});

describe('workerAttentionStore', () => {
  it('marks and clears worker attention', () => {
    markWorkerAttention(WORKER_ID);

    expect(hasWorkerAttention(WORKER_ID)).toBe(true);
    expect(__getWorkerAttentionSnapshotForTest().has(WORKER_ID)).toBe(true);

    expect(clearWorkerAttention(WORKER_ID)).toBe(true);
    expect(hasWorkerAttention(WORKER_ID)).toBe(false);
  });

  it('clears many worker attention ids', () => {
    markWorkerAttention(WORKER_ID);
    markWorkerAttention(OTHER_WORKER_ID);

    expect(clearWorkerAttentionMany([WORKER_ID, 'missing'])).toBe(1);

    const snapshot = __getWorkerAttentionSnapshotForTest();
    expect(snapshot.has(WORKER_ID)).toBe(false);
    expect(snapshot.has(OTHER_WORKER_ID)).toBe(true);
  });

  it('notifies subscribers when the snapshot changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    markWorkerAttention(WORKER_ID);
    clearWorkerAttention(WORKER_ID);
    unsubscribe();
    markWorkerAttention(WORKER_ID);

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
