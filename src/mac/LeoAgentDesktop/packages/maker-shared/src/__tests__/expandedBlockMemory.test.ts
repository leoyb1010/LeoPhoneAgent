import { describe, expect, it, vi } from 'vitest';

import { createExpandedBlockStore } from '../expandedBlockMemory.js';

describe('expandedBlockMemory — shared store core', () => {
  it('defaults every block id to collapsed (false)', () => {
    const store = createExpandedBlockStore();
    expect(store.isExpanded('thinking-a')).toBe(false);
    expect(store.isExpanded('tools-b')).toBe(false);
  });

  it('setExpanded flips state and notifies subscribers on change only', () => {
    const store = createExpandedBlockStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setExpanded('tools-a', true);
    expect(store.isExpanded('tools-a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op set (same value) must not notify — avoids render churn.
    store.setExpanded('tools-a', true);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setExpanded('tools-a', false);
    expect(store.isExpanded('tools-a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops notifications', () => {
    const store = createExpandedBlockStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setExpanded('tools-a', true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('evicts the oldest expanded entry beyond maxEntries', () => {
    const store = createExpandedBlockStore({ maxEntries: 2 });
    store.setExpanded('a', true);
    store.setExpanded('b', true);
    store.setExpanded('c', true);
    expect(store.isExpanded('a')).toBe(false);
    expect(store.isExpanded('b')).toBe(true);
    expect(store.isExpanded('c')).toBe(true);
  });

  it('routes subscriber errors to onSubscriberError without breaking other subscribers', () => {
    const onSubscriberError = vi.fn();
    const store = createExpandedBlockStore({ onSubscriberError });
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(healthy);

    store.setExpanded('a', true);
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('reset clears entries and subscribers', () => {
    const store = createExpandedBlockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setExpanded('a', true);
    store.reset();
    expect(store.isExpanded('a')).toBe(false);
    store.setExpanded('b', true);
    expect(listener).toHaveBeenCalledTimes(1); // only the pre-reset notification
  });
});
