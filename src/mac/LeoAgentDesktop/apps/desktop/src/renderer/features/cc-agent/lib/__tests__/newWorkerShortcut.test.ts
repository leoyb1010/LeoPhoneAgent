import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestNewWorkerFromShortcut,
  subscribeNewWorkerShortcut,
} from '../newWorkerShortcut';

describe('newWorkerShortcut', () => {
  const unsubscribers: Array<() => void> = [];
  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  it('checks subscribers until a visible collaboration panel accepts the shortcut', async () => {
    const ignored = vi.fn(() => false);
    const accepted = vi.fn(() => true);
    unsubscribers.push(subscribeNewWorkerShortcut(ignored));
    unsubscribers.push(subscribeNewWorkerShortcut(accepted));

    await expect(requestNewWorkerFromShortcut()).resolves.toBe(true);
    expect(ignored).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('returns false after the visible consumer unregisters', async () => {
    const unsubscribe = subscribeNewWorkerShortcut(() => true);
    unsubscribe();
    await expect(requestNewWorkerFromShortcut()).resolves.toBe(false);
  });
});
