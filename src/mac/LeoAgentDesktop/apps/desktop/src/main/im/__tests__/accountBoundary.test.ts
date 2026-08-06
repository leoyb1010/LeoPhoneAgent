import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activateImAccountBoundary,
  captureImAccountGeneration,
  deactivateImAccountBoundary,
  runInImAccountGeneration,
  waitForImAccountGenerationIdle,
} from '../accountBoundary';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('IM account boundary', () => {
  afterEach(() => activateImAccountBoundary());

  it('rejects queued work whose generation closed before execution', async () => {
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    const operation = vi.fn(async () => undefined);

    const work = runInImAccountGeneration(token!, operation);
    deactivateImAccountBoundary();

    await expect(work).rejects.toMatchObject({ code: 'IM_ACCOUNT_SCOPE_CLOSED' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('drains a handler admitted by the closing account before teardown continues', async () => {
    const gate = deferred();
    const token = captureImAccountGeneration();
    expect(token).not.toBeNull();
    let started = false;
    const work = runInImAccountGeneration(token!, async () => {
      started = true;
      await gate.promise;
    });
    await vi.waitFor(() => expect(started).toBe(true));

    deactivateImAccountBoundary();
    let drained = false;
    const draining = waitForImAccountGenerationIdle(token!).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    gate.resolve();
    await work;
    await draining;
    expect(drained).toBe(true);
  });
});
