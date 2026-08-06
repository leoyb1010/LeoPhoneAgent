import { type SidecarLockAcquireOptions, type SidecarLockHandle, type SidecarLockHeldEntry, type SidecarLockRetryOptions, type SidecarLockStaleRecovery } from "./sidecar-lock.js";
export type FileLockRetryOptions = SidecarLockRetryOptions;
export type FileLockStaleRecovery = SidecarLockStaleRecovery;
export type FileLockAcquireOptions<TPayload extends Record<string, unknown>> = Omit<SidecarLockAcquireOptions<TPayload>, "targetPath" | "staleMs"> & {
    managerKey?: string;
    staleMs?: number;
};
export type FileLockHandle = SidecarLockHandle;
export type FileLockHeldEntry = SidecarLockHeldEntry;
export type FileLockManager = {
    acquire<TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockAcquireOptions<TPayload>): Promise<FileLockHandle>;
    withLock<T, TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockAcquireOptions<TPayload>, fn: () => Promise<T>): Promise<T>;
    drain(): Promise<void>;
    reset(): void;
    heldEntries(): FileLockHeldEntry[];
};
export declare function acquireFileLock<TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockAcquireOptions<TPayload>): Promise<FileLockHandle>;
export declare function withFileLock<T, TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockAcquireOptions<TPayload>, fn: () => Promise<T>): Promise<T>;
export declare function createFileLockManager(key: string): FileLockManager;
export declare function drainFileLockManagerForTest(targetPath: string, managerKey?: string): Promise<void>;
export declare function resetFileLockManagerForTest(targetPath: string, managerKey?: string): void;
//# sourceMappingURL=file-lock.d.ts.map