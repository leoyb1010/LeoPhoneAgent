/**
 * Pending queue lock ownership helpers.
 *
 * Queue edit/drag locks live in makerChatStore per session, while
 * ChatInput/PendingQueuePanel components are reused when the visible session
 * changes. Releasing through "latest props" can unlock the new session and
 * leave the old session blocked forever. Capture the callback that acquired a
 * lock and always use that same callback to release it.
 */

export type QueueInteractionLockCallback = (lockId: string, locked: boolean) => void;
export type QueueEditLockCallback = (clientId: string, locked: boolean) => void;

export interface QueueInteractionLockOwner {
  lockId: string;
  callback?: QueueInteractionLockCallback;
}

export interface QueueEditLockOwner {
  clientId: string;
  callback?: QueueEditLockCallback;
}

export function acquireQueueInteractionLock(
  lockId: string,
  callback: QueueInteractionLockCallback | undefined,
): QueueInteractionLockOwner {
  callback?.(lockId, true);
  return { lockId, callback };
}

export function releaseQueueInteractionLock(owner: QueueInteractionLockOwner | null): null {
  owner?.callback?.(owner.lockId, false);
  return null;
}

export function acquireQueueEditLock(
  owner: QueueEditLockOwner | null,
  clientId: string,
  callback: QueueEditLockCallback | undefined,
): QueueEditLockOwner {
  if (owner?.clientId === clientId) return owner;
  owner?.callback?.(owner.clientId, false);
  callback?.(clientId, true);
  return { clientId, callback };
}

export function releaseQueueEditLock(
  owner: QueueEditLockOwner | null,
  clientId?: string | null,
): QueueEditLockOwner | null {
  const targetClientId = clientId ?? owner?.clientId ?? null;
  if (!owner || !targetClientId || owner.clientId !== targetClientId) return owner;
  owner.callback?.(targetClientId, false);
  return null;
}
