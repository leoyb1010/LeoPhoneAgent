import { createSidecarLockManager, } from "./sidecar-lock.js";
import { getFsSafeLockConfig } from "./lock-config.js";
function resolveFileLockManagerKey(targetPath, managerKey) {
    return managerKey ?? `fs-safe.file-lock:${targetPath}`;
}
function withLockDefaults(options) {
    const defaults = getFsSafeLockConfig();
    return {
        ...options,
        retry: options.retry ?? defaults.retry,
        staleMs: options.staleMs ?? defaults.staleMs ?? 30_000,
        staleRecovery: options.staleRecovery ?? defaults.staleRecovery,
        timeoutMs: options.timeoutMs ?? defaults.timeoutMs,
    };
}
export async function acquireFileLock(targetPath, options) {
    return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
        .acquire(targetPath, options);
}
export async function withFileLock(targetPath, options, fn) {
    return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey))
        .withLock(targetPath, options, fn);
}
export function createFileLockManager(key) {
    const manager = createSidecarLockManager(key);
    return {
        acquire: async (targetPath, options) => {
            const { managerKey: _managerKey, ...acquireOptions } = options;
            return await manager.acquire({ ...withLockDefaults(acquireOptions), targetPath });
        },
        withLock: async (targetPath, options, fn) => {
            const { managerKey: _managerKey, ...acquireOptions } = options;
            return await manager.withLock({ ...withLockDefaults(acquireOptions), targetPath }, fn);
        },
        drain: manager.drain,
        reset: manager.reset,
        heldEntries: manager.heldEntries,
    };
}
export async function drainFileLockManagerForTest(targetPath, managerKey) {
    await createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).drain();
}
export function resetFileLockManagerForTest(targetPath, managerKey) {
    createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).reset();
}
