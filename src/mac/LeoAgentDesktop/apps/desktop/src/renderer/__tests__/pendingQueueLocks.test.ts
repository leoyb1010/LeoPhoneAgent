import { describe, expect, it, vi } from 'vitest';

import {
  acquireQueueEditLock,
  acquireQueueInteractionLock,
  releaseQueueEditLock,
  releaseQueueInteractionLock,
} from '@/components/new-chat/pendingQueueLocks';

describe('pendingQueueLocks', () => {
  it('releases an edit lock through the callback that acquired it', () => {
    const firstSession = vi.fn();
    const secondSession = vi.fn();

    const owner = acquireQueueEditLock(null, 'row-a', firstSession);
    releaseQueueEditLock(owner, 'row-a');

    expect(firstSession.mock.calls).toEqual([
      ['row-a', true],
      ['row-a', false],
    ]);
    expect(secondSession).not.toHaveBeenCalled();
  });

  it('releases the previous edit lock before acquiring another row with the latest callback', () => {
    const firstSession = vi.fn();
    const secondSession = vi.fn();

    const firstOwner = acquireQueueEditLock(null, 'row-a', firstSession);
    const secondOwner = acquireQueueEditLock(firstOwner, 'row-b', secondSession);

    expect(firstSession.mock.calls).toEqual([
      ['row-a', true],
      ['row-a', false],
    ]);
    expect(secondSession).toHaveBeenCalledWith('row-b', true);
    expect(secondOwner).toMatchObject({ clientId: 'row-b' });
  });

  it('releases an interaction lock through the callback that acquired it', () => {
    const firstSession = vi.fn();
    const secondSession = vi.fn();

    const owner = acquireQueueInteractionLock('pending-queue-panel', firstSession);
    releaseQueueInteractionLock(owner);

    expect(firstSession.mock.calls).toEqual([
      ['pending-queue-panel', true],
      ['pending-queue-panel', false],
    ]);
    expect(secondSession).not.toHaveBeenCalled();
  });
});
