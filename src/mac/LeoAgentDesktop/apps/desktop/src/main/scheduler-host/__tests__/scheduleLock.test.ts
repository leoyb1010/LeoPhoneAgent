import { describe, expect, it, vi } from 'vitest';

import { withScheduleLock } from '../scheduleLock';

describe('withScheduleLock', () => {
  it('skips a queued callback that was aborted before it acquired the lock', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstController = new AbortController();
    const queuedController = new AbortController();
    const queuedCallback = vi.fn(async () => 'should not run');

    const first = withScheduleLock('schedule-1', firstController.signal, async () => firstGate);
    const queued = withScheduleLock('schedule-1', queuedController.signal, queuedCallback);

    queuedController.abort();
    await expect(queued).rejects.toThrow(/aborted while waiting for schedule lock/);
    expect(queuedCallback).not.toHaveBeenCalled();
    releaseFirst();

    await expect(first).resolves.toBeUndefined();
  });
});
