import { describe, expect, it, vi } from 'vitest';

import { createWorkerTurnStartSequencer } from '../workerTurnStartSequencer';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkerTurnStartSequencer', () => {
  it('waits for an in-flight start before terminal handling continues', async () => {
    const log = { warn: vi.fn() };
    const sequencer = createWorkerTurnStartSequencer(log);
    const start = deferred();
    const order: string[] = [];
    let workerStatus: 'idle' | 'running' | 'done' = 'idle';

    sequencer.start('worker-session-1', async () => {
      order.push('start-begin');
      await start.promise;
      workerStatus = 'running';
      order.push('start-running-written');
    });

    const terminal = sequencer.waitForStart('worker-session-1').then(() => {
      workerStatus = 'done';
      order.push('terminal-done-written');
    });
    await flushMicrotasks();

    expect(order).toEqual(['start-begin']);

    start.resolve();
    await terminal;

    expect(order).toEqual([
      'start-begin',
      'start-running-written',
      'terminal-done-written',
    ]);
    expect(workerStatus).toBe('done');
  });

  it('does not block terminal handling forever when the start update fails', async () => {
    const log = { warn: vi.fn() };
    const sequencer = createWorkerTurnStartSequencer(log);
    const failure = new Error('db unavailable');

    sequencer.start('worker-session-1', async () => {
      throw failure;
    });

    await expect(sequencer.waitForStart('worker-session-1')).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('orca worker turn start status update failed', {
      sessionId: 'worker-session-1',
      err: 'db unavailable',
    });
  });

  it('keeps waiting on the latest start when an older start settles later', async () => {
    const log = { warn: vi.fn() };
    const sequencer = createWorkerTurnStartSequencer(log);
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    sequencer.start('worker-session-1', async () => {
      await first.promise;
      order.push('first-start');
    });
    sequencer.start('worker-session-1', async () => {
      await second.promise;
      order.push('second-start');
    });

    const terminal = sequencer.waitForStart('worker-session-1').then(() => {
      order.push('terminal');
    });

    first.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['first-start']);

    second.resolve();
    await terminal;

    expect(order).toEqual(['first-start', 'second-start', 'terminal']);
  });
});
