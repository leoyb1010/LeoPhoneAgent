import type { Stats } from "node:fs";
export type AsyncDirectoryGuard = {
    dir: string;
    realPath: string;
    stat: Stats;
};
export type SyncDirectoryGuard = {
    dir: string;
    realPath: string;
    stat: Stats;
};
export declare function createAsyncDirectoryGuard(dir: string): Promise<AsyncDirectoryGuard>;
export declare function assertAsyncDirectoryGuard(guard: AsyncDirectoryGuard): Promise<void>;
export declare function createSyncDirectoryGuard(dir: string): SyncDirectoryGuard;
export declare function assertSyncDirectoryGuard(guard: SyncDirectoryGuard): void;
export declare function createNearestExistingDirectoryGuard(rootReal: string, targetPath: string): Promise<AsyncDirectoryGuard>;
export declare function createNearestExistingSyncDirectoryGuard(rootReal: string, targetPath: string): SyncDirectoryGuard;
//# sourceMappingURL=directory-guard.d.ts.map