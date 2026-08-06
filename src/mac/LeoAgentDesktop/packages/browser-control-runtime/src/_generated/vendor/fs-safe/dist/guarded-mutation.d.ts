import { type AsyncDirectoryGuard, type SyncDirectoryGuard } from "./directory-guard.js";
export declare function withAsyncDirectoryGuards<T>(guards: readonly AsyncDirectoryGuard[], mutate: () => Promise<T>, options?: {
    verifyAfter?: boolean;
    onPostGuardFailure?: (result: T, error: unknown) => Promise<void> | void;
}): Promise<T>;
export declare function withSyncDirectoryGuards<T>(guards: readonly SyncDirectoryGuard[], mutate: () => T, options?: {
    verifyAfter?: boolean;
}): T;
export declare function guardedRename(params: {
    from: string;
    to: string;
    targetRoot?: string;
    verifyAfter?: boolean;
}): Promise<void>;
export declare function guardedRenameSync(params: {
    from: string;
    to: string;
    targetRoot?: string;
    verifyAfter?: boolean;
}): void;
export declare function guardedRm(params: {
    target: string;
    recursive?: boolean;
    force?: boolean;
    verifyAfter?: boolean;
}): Promise<void>;
export declare function guardedRmSync(params: {
    target: string;
    recursive?: boolean;
    force?: boolean;
    verifyAfter?: boolean;
}): void;
//# sourceMappingURL=guarded-mutation.d.ts.map