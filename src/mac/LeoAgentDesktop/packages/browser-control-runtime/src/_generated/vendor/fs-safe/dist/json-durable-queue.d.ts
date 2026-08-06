export type JsonDurableQueueEntryPaths = {
    jsonPath: string;
    deliveredPath: string;
};
export type JsonDurableQueueReadResult<T> = {
    entry: T;
    migrated?: boolean;
};
export type JsonDurableQueueLoadOptions<T> = {
    queueDir: string;
    tempPrefix: string;
    read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
    cleanupTmpMaxAgeMs?: number;
    maxBytes?: number;
};
export declare const DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES: number;
export declare function unlinkBestEffort(filePath: string): Promise<void>;
export declare function jsonDurableQueueEntryExists(filePath: string): Promise<boolean>;
export declare function resolveJsonDurableQueueEntryPaths(queueDir: string, id: string): JsonDurableQueueEntryPaths;
export declare function ensureJsonDurableQueueDirs(params: {
    queueDir: string;
    failedDir: string;
}): Promise<void>;
export declare function writeJsonDurableQueueEntry(params: {
    filePath: string;
    entry: unknown;
    tempPrefix: string;
}): Promise<void>;
export declare function readJsonDurableQueueEntry<T>(filePath: string, options?: {
    maxBytes?: number;
}): Promise<T>;
export declare function ackJsonDurableQueueEntry(paths: JsonDurableQueueEntryPaths): Promise<void>;
export declare function loadJsonDurableQueueEntry<T>(params: {
    paths: JsonDurableQueueEntryPaths;
    tempPrefix: string;
    read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
    maxBytes?: number;
}): Promise<T | null>;
export declare function loadPendingJsonDurableQueueEntries<T>(options: JsonDurableQueueLoadOptions<T>): Promise<T[]>;
export declare function moveJsonDurableQueueEntryToFailed(params: {
    queueDir: string;
    failedDir: string;
    id: string;
}): Promise<void>;
//# sourceMappingURL=json-durable-queue.d.ts.map