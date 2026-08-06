export type SidecarLockRetryOptions = {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
};
export type SidecarLockStaleRecovery = "fail-closed" | "remove-if-unchanged";
export type SidecarLockStaleSnapshot = {
    lockPath: string;
    normalizedTargetPath: string;
    raw: string;
    payload: Record<string, unknown> | null;
};
export type SidecarLockAcquireOptions<TPayload extends Record<string, unknown>> = {
    targetPath: string;
    lockPath?: string;
    staleMs: number;
    timeoutMs?: number;
    retry?: SidecarLockRetryOptions;
    staleRecovery?: SidecarLockStaleRecovery;
    allowReentrant?: boolean;
    payload: () => TPayload | Promise<TPayload>;
    shouldReclaim?: (params: {
        lockPath: string;
        normalizedTargetPath: string;
        payload: Record<string, unknown> | null;
        staleMs: number;
        nowMs: number;
        heldByThisProcess: boolean;
    }) => boolean | Promise<boolean>;
    shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
    metadata?: Record<string, unknown>;
};
export type SidecarLockHandle = {
    lockPath: string;
    normalizedTargetPath: string;
    release: () => Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
};
export type SidecarLockHeldEntry = {
    normalizedTargetPath: string;
    lockPath: string;
    acquiredAt: number;
    metadata: Record<string, unknown>;
    forceRelease: () => Promise<boolean>;
};
export type WithSidecarLockOptions<TPayload extends Record<string, unknown>> = Omit<SidecarLockAcquireOptions<TPayload>, "targetPath"> & {
    managerKey?: string;
};
export declare function createSidecarLockManager(key: string): {
    acquire: <TPayload extends Record<string, unknown>>(options: SidecarLockAcquireOptions<TPayload>) => Promise<SidecarLockHandle>;
    withLock: <T, TPayload extends Record<string, unknown>>(options: SidecarLockAcquireOptions<TPayload>, fn: () => Promise<T>) => Promise<T>;
    drain: () => Promise<void>;
    reset: () => void;
    heldEntries: () => SidecarLockHeldEntry[];
};
export declare function withSidecarLock<T, TPayload extends Record<string, unknown>>(targetPath: string, options: WithSidecarLockOptions<TPayload>, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=sidecar-lock.d.ts.map