export type OwnerEnsureResult =
  | { ready: true }
  | {
      ready: false;
      error: { code: string; message: string };
    };

interface OwnerEnsureCoordinatorDeps {
  isOwnerCurrent(ownerId: string): boolean;
  beforeEnsureReady?(ownerId: string): void | Promise<void>;
  ensureReady(ownerId: string): Promise<OwnerEnsureResult>;
  onReady?(ownerId: string): void | Promise<void>;
  onReadyError?(ownerId: string, error: unknown): void;
  discardReadyOwner(ownerId: string): void | Promise<void>;
}

const staleResult = (): OwnerEnsureResult => ({
  ready: false,
  error: {
    code: 'DB_INIT_FAILED',
    message: 'local database owner changed while initialization was in progress',
  },
});

const readyHookFailureResult = (error: unknown): OwnerEnsureResult => ({
  ready: false,
  error: {
    code: 'DB_INIT_FAILED',
    message: `local database startup hook failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  },
});

/**
 * Serialize owner database initialization and reject work superseded by an
 * application-session switch. The queue is essential: it lets a stale task
 * discard only its own committed DB before the next owner starts opening one.
 */
export function createOwnerEnsureCoordinator(deps: OwnerEnsureCoordinatorDeps) {
  let tail: Promise<void> = Promise.resolve();

  return (ownerId: string): Promise<OwnerEnsureResult> => {
    const operation = tail.then(async () => {
      if (!deps.isOwnerCurrent(ownerId)) return staleResult();

      await deps.beforeEnsureReady?.(ownerId);
      if (!deps.isOwnerCurrent(ownerId)) return staleResult();

      const result = await deps.ensureReady(ownerId);
      if (!deps.isOwnerCurrent(ownerId)) {
        await deps.discardReadyOwner(ownerId);
        return staleResult();
      }

      if (result.ready && deps.onReady) {
        try {
          await deps.onReady(ownerId);
        } catch (error) {
          deps.onReadyError?.(ownerId, error);
          // ensureReady has already committed this owner's DB. A failed
          // lifecycle hook must roll it back so a renderer retry can perform a
          // complete initialization instead of observing a half-ready owner.
          await deps.discardReadyOwner(ownerId);
          return readyHookFailureResult(error);
        }
      }
      if (!deps.isOwnerCurrent(ownerId)) {
        await deps.discardReadyOwner(ownerId);
        return staleResult();
      }

      return result;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}
