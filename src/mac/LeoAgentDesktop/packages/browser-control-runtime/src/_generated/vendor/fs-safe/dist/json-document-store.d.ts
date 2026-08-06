import type { FileLockRetryOptions } from "./file-lock.js";
import type { SidecarLockStaleRecovery } from "./sidecar-lock.js";
export type JsonStoreLockOptions = {
    staleMs?: number;
    timeoutMs?: number;
    retry?: FileLockRetryOptions;
    staleRecovery?: SidecarLockStaleRecovery;
    managerKey?: string;
};
export type JsonFileStoreOptions = {
    trailingNewline?: boolean;
    lock?: boolean | JsonStoreLockOptions;
};
export type JsonStore<T> = {
    readonly filePath: string;
    read(): Promise<T | undefined>;
    readOr(fallback: T): Promise<T>;
    readRequired(): Promise<T>;
    write(value: T): Promise<void>;
    update(run: (current: T | undefined) => T | Promise<T>): Promise<T>;
    updateOr(fallback: T, run: (current: T) => T | Promise<T>): Promise<T>;
};
export type JsonStoreAdapter<T> = {
    filePath: string;
    readIfExists(): Promise<T | undefined>;
    readRequired(): Promise<T>;
    write(value: T, options?: {
        trailingNewline?: boolean;
    }): Promise<void>;
};
export declare function createJsonStore<T>(adapter: JsonStoreAdapter<T>, options?: JsonFileStoreOptions): JsonStore<T>;
//# sourceMappingURL=json-document-store.d.ts.map