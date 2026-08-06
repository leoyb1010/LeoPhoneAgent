export type FileStorePruneOptions = {
    ttlMs: number;
    recursive?: boolean;
    maxDepth?: number;
    pruneEmptyDirs?: boolean;
};
export declare function pruneExpiredStoreEntries(params: {
    rootDir: string;
    dirMode: number;
    options: FileStorePruneOptions;
}): Promise<void>;
//# sourceMappingURL=file-store-prune.d.ts.map