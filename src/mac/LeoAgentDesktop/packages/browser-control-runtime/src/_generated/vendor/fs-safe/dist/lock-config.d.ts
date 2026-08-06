import type { SidecarLockRetryOptions, SidecarLockStaleRecovery } from "./sidecar-lock.js";
export type FsSafeLockConfig = {
    staleRecovery: SidecarLockStaleRecovery;
    staleMs?: number;
    timeoutMs?: number;
    retry?: SidecarLockRetryOptions;
};
export declare function configureFsSafeLocks(config: Partial<FsSafeLockConfig>): void;
export declare function getFsSafeLockConfig(): FsSafeLockConfig;
//# sourceMappingURL=lock-config.d.ts.map