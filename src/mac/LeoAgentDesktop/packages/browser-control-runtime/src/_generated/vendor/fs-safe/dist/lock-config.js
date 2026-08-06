const DEFAULT_LOCK_CONFIG = {
    staleRecovery: "fail-closed",
};
let lockConfig = { ...DEFAULT_LOCK_CONFIG };
export function configureFsSafeLocks(config) {
    // Process defaults only fill lock options after a caller explicitly enables
    // locking for a resource; this must never turn sidecar locks on globally.
    lockConfig = { ...lockConfig, ...config };
}
export function getFsSafeLockConfig() {
    return { ...lockConfig, retry: lockConfig.retry ? { ...lockConfig.retry } : undefined };
}
