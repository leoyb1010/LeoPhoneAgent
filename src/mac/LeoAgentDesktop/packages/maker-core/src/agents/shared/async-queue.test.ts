import { describe, expect, it } from 'vitest';

import { createAsyncQueue } from './async-queue.js';

describe('createAsyncQueue', () => {
  it('reports whether a push was accepted', async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    expect(queue.push('first')).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });

    queue.end();

    expect(queue.push('after-end')).toBe(false);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('clears queued items without ending the queue', async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    expect(queue.push('stale')).toBe(true);
    expect(queue.pending).toBe(1);

    queue.clear();
    expect(queue.pending).toBe(0);

    expect(queue.push('fresh')).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'fresh' });

    queue.end();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
